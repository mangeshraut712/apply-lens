#!/usr/bin/env python3
"""Score a job description against product pages captured in this sandbox."""

from __future__ import annotations

import argparse
import contextlib
import errno
import json
import os
import re
import stat
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TypedDict

# Sandbox contract: index.ts and `npm run score:fixtures` use this directory.
_DEFAULT_ROOT = "/tmp/apply-lens"  # noqa: S108
MAX_PAGE_BYTES = 512 * 1024
MAX_TEXT_CHARS = 24_000
MAX_PAGES = 32
_TECH_LIST_LIMIT = 24

STOP = {
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "your",
    "you",
    "are",
    "our",
    "will",
    "have",
    "has",
    "was",
    "were",
    "been",
    "being",
    "into",
    "onto",
    "over",
    "under",
    "about",
    "than",
    "then",
    "them",
    "they",
    "their",
    "there",
    "here",
    "what",
    "when",
    "where",
    "which",
    "who",
    "how",
    "why",
    "not",
    "but",
    "can",
    "all",
    "any",
    "more",
    "most",
    "other",
    "also",
    "just",
    "like",
    "use",
    "using",
    "used",
    "work",
    "working",
    "role",
    "team",
    "join",
    "across",
    "within",
    "including",
    "plus",
    "etc",
    "via",
    "per",
    "each",
    "both",
}

TECH = {
    "python",
    "java",
    "typescript",
    "javascript",
    "golang",
    "rust",
    "c++",
    "react",
    "nextjs",
    "next.js",
    "vue",
    "node",
    "fastapi",
    "django",
    "spring",
    "aws",
    "gcp",
    "azure",
    "kubernetes",
    "docker",
    "terraform",
    "postgres",
    "postgresql",
    "mysql",
    "redis",
    "mongodb",
    "kafka",
    "graphql",
    "grpc",
    "playwright",
    "puppeteer",
    "llm",
    "rag",
    "mcp",
    "agent",
    "agents",
    "sandbox",
    "browser",
    "chrome",
    "cdp",
    "nosql",
    "sqlite",
    "nodejs",
    "reactjs",
    "vuejs",
    "k8s",
    "node.js",
    "react.js",
    "vue.js",
}

_SHORT_TECH = frozenset({"go", "c#", "f#"})
_TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9.+#-]{1,}")
_PAGE_NAME = re.compile(r"page-(\d+)\.json")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]+")
_DASHES = str.maketrans(
    {
        "\u2010": " ",
        "\u2011": " ",
        "\u2012": " ",
        "\u2013": " ",
        "\u2014": " ",
        "\u2212": " ",
        "-": " ",
        "/": " ",
        "_": " ",
    }
)

_BUZZ_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (
        label,
        re.compile(rf"(?<![a-z0-9])(?:{expr})(?![a-z0-9])"),
    )
    for label, expr in (
        ("world class", r"world\s+class"),
        ("fast paced", r"fast\s+paced"),
        ("ninja", r"ninjas?"),
        ("rockstar", r"rock\s*stars?"),
        ("disrupt", r"disrupt(?:ions?|ing|ive|ed|s)?"),
        ("synergy", r"synerg(?:y|ies|istic)"),
        ("10x", r"10x"),
        ("unlimited pto", r"unlimited\s+pto"),
    )
)

_AGREE = "JD and live product roughly agree."
_DIVERGE = "JD and live product diverge — read the site before you apply."
_NO_PRODUCT = "No live product pages were captured — capture the company site before you apply."
_NO_PRODUCT_TEXT = "Live product pages had no usable text — the site may have blocked capture."


class ScoreError(Exception):
    """A capture could not be scored safely."""


class CapturedPage(TypedDict):
    url: str
    title: str
    text: str


class PageSummary(TypedDict):
    url: str
    title: str
    chars: int


class Report(TypedDict):
    job_url: str
    job_title: str
    pages_captured: list[PageSummary]
    support_score: float
    jd_tech: list[str]
    product_tech: list[str]
    listed_in_jd_missing_on_site: list[str]
    on_site_not_in_jd: list[str]
    buzzwords: list[str]
    interview_questions: list[str]
    verdict: str


@dataclass(frozen=True, slots=True)
class CliConfig:
    root: Path


def tokens(text: str) -> set[str]:
    """Return significant lowercase tokens from ``text``."""
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    found: set[str] = set()
    for match in _TOKEN_RE.finditer(text.lower()):
        word = match.group(0).strip(".")
        if not word or word in STOP:
            continue
        if len(word) > 2 or word in _SHORT_TECH:
            found.add(word)
    return found


def load_pages(root: Path) -> list[CapturedPage]:
    """Load ``page-<n>.json`` captures from ``root`` in numeric order."""
    directory = _validate_root(root)
    matches: list[tuple[int, str]] = []
    try:
        with os.scandir(directory) as entries:
            for entry in entries:
                match = _PAGE_NAME.fullmatch(entry.name)
                if match is None:
                    continue
                matches.append((int(match.group(1)), entry.name))
    except OSError as exc:
        raise ScoreError("could not read capture directory") from exc
    if not matches:
        raise ScoreError("no captured pages")
    matches.sort()
    if len(matches) > MAX_PAGES:
        raise ScoreError(f"too many captured pages ({len(matches)}); limit is {MAX_PAGES}")
    pages: list[CapturedPage] = []
    for _index, name in matches:
        path = directory / name
        parsed = _load_page_json(path)
        pages.append(_normalize_page(parsed, name))
    return pages


def build_report(pages: Sequence[Mapping[str, object]]) -> Report:
    """Score ``pages[0]`` as the posting and the rest as the live product."""
    normalized = [
        _normalize_page(page, f"page-{index:02d}.json") for index, page in enumerate(pages)
    ]
    deduped = _dedupe_pages(normalized)
    if not deduped:
        raise ScoreError("no captured pages")
    if len(deduped) > MAX_PAGES:
        raise ScoreError(f"too many captured pages ({len(deduped)}); limit is {MAX_PAGES}")

    job = deduped[0]
    product = deduped[1:]
    jd_tok = tokens(job["text"])
    prod_tok: set[str] = set()
    for page in product:
        prod_tok.update(tokens(page["text"]))

    jd_tech = _tech_list(jd_tok)
    prod_tech = _tech_list(prod_tok)
    missing = sorted(set(jd_tech) - set(prod_tech))
    extra = sorted(set(prod_tech) - set(jd_tech))
    overlap = jd_tok & prod_tok
    support = round(100 * len(overlap) / max(len(jd_tok), 1), 1)
    verdict = _verdict(len(product), prod_tok, support, missing)

    questions = _questions(prod_tech, missing)
    return {
        "job_url": job["url"],
        "job_title": job["title"],
        "pages_captured": [
            {"url": page["url"], "title": page["title"], "chars": len(page["text"])}
            for page in deduped
        ],
        "support_score": support,
        "jd_tech": jd_tech[:_TECH_LIST_LIMIT],
        "product_tech": prod_tech[:_TECH_LIST_LIMIT],
        "listed_in_jd_missing_on_site": missing,
        "on_site_not_in_jd": extra,
        "buzzwords": _buzzwords(job["text"]),
        "interview_questions": questions,
        "verdict": verdict,
    }


def render_markdown(report: Report) -> str:
    """Render ``report`` as the markdown file the CLI prints."""
    lines = [
        "# Apply Lens report",
        "",
        f"**Posting:** {report['job_title']}  ",
        f"**URL:** {report['job_url']}  ",
        f"**Support score:** {report['support_score']}  ",
        f"**Verdict:** {report['verdict']}",
        "",
        "## Tech listed in the posting",
        ", ".join(report["jd_tech"]) or "_(none detected)_",
        "",
        "## Tech visible on the live site",
        ", ".join(report["product_tech"]) or "_(none detected)_",
        "",
        "## In the JD, missing from the site",
        ", ".join(report["listed_in_jd_missing_on_site"]) or "_(none)_",
        "",
        "## On the site, missing from the JD",
        ", ".join(report["on_site_not_in_jd"]) or "_(none)_",
        "",
        "## Interview questions from the live product",
    ]
    lines.extend(f"- {question}" for question in report["interview_questions"])
    return "\n".join(lines) + "\n"


def write_reports(root: Path, report: Report) -> None:
    """Atomically write ``report.json`` and ``report.md`` inside ``root``."""
    directory = _validate_root(root)
    _atomic_write(directory / "report.json", json.dumps(report, indent=2))
    _atomic_write(directory / "report.md", render_markdown(report))


def parse_args(argv: list[str] | None = None) -> CliConfig:
    """Parse CLI arguments. ``APPLY_LENS_ROOT`` overrides the default directory."""
    parser = argparse.ArgumentParser(
        description="Score a job description against captured product pages."
    )
    parser.add_argument(
        "--root",
        default=None,
        help="Directory of page-N.json captures (default: APPLY_LENS_ROOT or the sandbox dir)",
    )
    namespace = parser.parse_args(argv)
    chosen = namespace.root
    if not isinstance(chosen, str) or not chosen.strip():
        chosen = os.environ.get("APPLY_LENS_ROOT", "").strip() or _DEFAULT_ROOT
    return CliConfig(root=Path(chosen))


def main(argv: list[str] | None = None) -> None:
    """Load captures from ``--root``, write the report, and print the markdown."""
    config = parse_args(argv)
    try:
        pages = load_pages(config.root)
        report = build_report(pages)
        write_reports(config.root, report)
    except ScoreError as exc:
        raise SystemExit(str(exc)) from None
    print(render_markdown(report))


def _tech_list(words: set[str]) -> list[str]:
    return sorted(word for word in words if _is_tech(word))


def _is_tech(word: str) -> bool:
    return word in TECH or word in _SHORT_TECH or word.endswith((".js", ".ts"))


def _verdict(product_pages: int, prod_tok: set[str], support: float, missing: list[str]) -> str:
    if product_pages == 0:
        return _NO_PRODUCT
    if not prod_tok:
        return _NO_PRODUCT_TEXT
    if support >= 18 and len(missing) <= 3:
        return _AGREE
    return _DIVERGE


def _questions(prod_tech: list[str], missing: list[str]) -> list[str]:
    questions: list[str] = []
    if prod_tech:
        questions.append(
            f"Walk me through how you use {prod_tech[0]} in production, not in a take-home."
        )
    if missing:
        questions.append(
            "The posting lists "
            f"{missing[0]} but the live site does not. Where does that work actually live?"
        )
    questions.append("What would a new hire ship in week one that a customer would notice?")
    questions.append("Which metric tells you this product has product-market fit?")
    return questions


def _buzzwords(text: str) -> list[str]:
    haystack = _normalize_buzz(text)
    return [label for label, pattern in _BUZZ_PATTERNS if pattern.search(haystack)]


def _normalize_buzz(text: str) -> str:
    lowered = _CONTROL_RE.sub(" ", text.lower()).translate(_DASHES)
    return re.sub(r"\s+", " ", lowered)


def _normalize_page(raw: object, name: str) -> CapturedPage:
    if not isinstance(raw, Mapping):
        raise ScoreError(f"{name}: page must be a JSON object")
    text = _field_str(raw.get("text"), name, "text")
    if len(text) > MAX_TEXT_CHARS:
        text = text[:MAX_TEXT_CHARS]
    return {
        "url": _one_line(_field_str(raw.get("url"), name, "url")),
        "title": _one_line(_field_str(raw.get("title"), name, "title")),
        "text": text,
    }


def _field_str(value: object, name: str, field: str) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    raise ScoreError(f"{name}: {field} must be a string")


def _dedupe_pages(pages: list[CapturedPage]) -> list[CapturedPage]:
    seen: set[str] = set()
    unique: list[CapturedPage] = []
    for index, page in enumerate(pages):
        key = page["url"].strip().rstrip("/")
        if not key:
            key = f"\0{index}"
        if key in seen:
            continue
        seen.add(key)
        unique.append(page)
    return unique


def _one_line(value: str, limit: int = 300) -> str:
    cleaned = _CONTROL_RE.sub(" ", value)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 3] + "..."


def _validate_root(root: Path) -> Path:
    if not isinstance(root, Path):
        raise ScoreError("capture directory must be a path")
    try:
        candidate = root.expanduser()
    except (OSError, RuntimeError, ValueError) as exc:
        raise ScoreError("capture directory is not usable") from exc
    raw = os.fspath(candidate)
    if "\x00" in raw:
        raise ScoreError("capture directory is not usable")
    if candidate.is_symlink():
        raise ScoreError("capture directory must not be a symlink")
    if not candidate.exists():
        raise ScoreError(f"capture directory not found: {_one_line(str(candidate))}")
    if not candidate.is_dir():
        raise ScoreError(f"capture directory is not a directory: {_one_line(str(candidate))}")
    return candidate


def _load_page_json(path: Path) -> object:
    data = _read_regular_file(path)
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ScoreError(f"{path.name}: not valid UTF-8") from exc
    try:
        return json.loads(text)
    except (json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise ScoreError(f"{path.name}: invalid JSON") from exc


def _read_regular_file(path: Path) -> bytes:
    """Read a regular file without following a symlink in the final path component."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise ScoreError(f"{path.name}: refusing to follow a symlink") from exc
        raise ScoreError(f"{path.name}: unreadable") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ScoreError(f"{path.name}: not a regular file")
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(fd, 64 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_PAGE_BYTES:
                raise ScoreError(f"{path.name}: file exceeds {MAX_PAGE_BYTES} bytes")
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(fd)


def _atomic_write(path: Path, content: str) -> None:
    """Write ``content`` without following an existing symlink at ``path``."""
    tmp_name: str | None = None
    try:
        fd, tmp_name = tempfile.mkstemp(
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=os.fspath(path.parent),
        )
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(content)
        os.replace(tmp_name, path)
        tmp_name = None
    except OSError as exc:
        raise ScoreError(f"could not write {path.name}") from exc
    finally:
        if tmp_name is not None:
            with contextlib.suppress(OSError):
                os.unlink(tmp_name)


__all__ = [
    "MAX_PAGES",
    "MAX_PAGE_BYTES",
    "MAX_TEXT_CHARS",
    "CapturedPage",
    "CliConfig",
    "Report",
    "ScoreError",
    "build_report",
    "load_pages",
    "main",
    "parse_args",
    "render_markdown",
    "tokens",
    "write_reports",
]


if __name__ == "__main__":
    main()
