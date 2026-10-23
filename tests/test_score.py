"""Behavior tests for the Apply Lens scorer."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

from score import (
    MAX_PAGE_BYTES,
    MAX_PAGES,
    ScoreError,
    build_report,
    load_pages,
    main,
    parse_args,
    render_markdown,
    tokens,
    write_reports,
)

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "docs" / "fixtures"

JD_TECH = [
    "aws",
    "azure",
    "django",
    "gcp",
    "graphql",
    "grpc",
    "java",
    "kafka",
    "kubernetes",
    "mcp",
    "playwright",
    "spring",
    "terraform",
    "typescript",
]
PRODUCT_TECH = [
    "agents",
    "browser",
    "cdp",
    "chrome",
    "llm",
    "playwright",
    "puppeteer",
    "python",
    "rag",
    "sandbox",
    "typescript",
]


def _page(url: str, title: str, text: str) -> dict[str, object]:
    return {"url": url, "title": title, "text": text}


def _write_page(directory: Path, name: str, payload: object) -> None:
    (directory / name).write_text(json.dumps(payload), encoding="utf-8")


def test_tokens_drop_stopwords_and_keep_short_tech() -> None:
    found = tokens("The team will use Go and C# plus Python.")
    assert "the" not in found
    assert "team" not in found
    assert "use" not in found
    assert found >= {"go", "c#", "python"}


def test_tokens_reject_non_strings() -> None:
    with pytest.raises(TypeError):
        tokens(None)  # type: ignore[arg-type]


def test_tokens_large_input_stays_fast() -> None:
    text = "python " * 20_000
    started = time.perf_counter()
    found = tokens(text)
    assert time.perf_counter() - started < 0.5
    assert "python" in found


def test_fixture_report_matches_checked_in_capture() -> None:
    report = build_report(load_pages(FIXTURES))
    assert report["support_score"] == 7.8
    assert report["job_url"] == "https://jobs.example.com/staff-platform-engineer"
    assert report["job_title"] == "Staff Platform Engineer — stealth AI infra (Series B)"
    assert [page["chars"] for page in report["pages_captured"]] == [540, 473, 390]
    assert report["jd_tech"] == JD_TECH
    assert report["product_tech"] == PRODUCT_TECH
    assert report["listed_in_jd_missing_on_site"] == [
        "aws",
        "azure",
        "django",
        "gcp",
        "graphql",
        "grpc",
        "java",
        "kafka",
        "kubernetes",
        "mcp",
        "spring",
        "terraform",
    ]
    assert report["on_site_not_in_jd"] == [
        "agents",
        "browser",
        "cdp",
        "chrome",
        "llm",
        "puppeteer",
        "python",
        "rag",
        "sandbox",
    ]
    assert report["buzzwords"] == [
        "world class",
        "fast paced",
        "ninja",
        "rockstar",
        "disrupt",
        "synergy",
        "10x",
        "unlimited pto",
    ]
    assert report["interview_questions"] == [
        "Walk me through how you use agents in production, not in a take-home.",
        "The posting lists aws but the live site does not. Where does that work actually live?",
        "What would a new hire ship in week one that a customer would notice?",
        "Which metric tells you this product has product-market fit?",
    ]
    assert report["verdict"] == "JD and live product diverge — read the site before you apply."
    markdown = render_markdown(report)
    assert markdown.startswith("# Apply Lens report\n")
    assert "**Support score:** 7.8  \n" in markdown
    assert "## Buzzwords in the posting\n" in markdown
    assert "world class" in markdown
    assert "roughly agree" not in markdown


def test_missing_product_pages_do_not_score_as_agreement() -> None:
    report = build_report(
        [_page("https://jobs.example/role", "Role", "We use Kubernetes and Kafka in production.")]
    )
    assert report["support_score"] == 0.0
    assert report["verdict"] == (
        "No live product pages were captured — capture the company site before you apply."
    )
    assert "roughly agree" not in report["verdict"]


def test_empty_product_text_does_not_fall_back_to_the_posting() -> None:
    report = build_report(
        [
            _page("https://jobs.example/role", "Role", "We use Kubernetes and Kafka."),
            _page("https://example.com/product", "Product", " \n\t"),
        ]
    )
    assert report["support_score"] == 0.0
    assert report["verdict"] == (
        "Live product pages had no usable text — the site may have blocked capture."
    )


def test_duplicate_product_url_is_not_scored_twice() -> None:
    report = build_report(
        [
            _page("https://jobs.example/role", "Role", "Kubernetes and Kafka and Terraform"),
            _page("https://jobs.example/role/", "Same", "Python sandbox browser agents"),
            _page("https://example.com/docs", "Docs", "Python sandbox"),
        ]
    )
    assert [page["url"] for page in report["pages_captured"]] == [
        "https://jobs.example/role",
        "https://example.com/docs",
    ]
    assert "python" in report["product_tech"]
    assert "kubernetes" in report["listed_in_jd_missing_on_site"]


def test_agree_when_posting_and_product_share_tech() -> None:
    text = "python typescript react kubernetes docker"
    report = build_report(
        [
            _page("https://jobs.example/role", "Role", text),
            _page("https://example.com/product", "Product", text),
        ]
    )
    assert report["support_score"] == 100.0
    assert report["listed_in_jd_missing_on_site"] == []
    assert report["verdict"] == "JD and live product roughly agree."


def test_buzzwords_ignore_hyphenation_and_embedded_10x() -> None:
    report = build_report(
        [
            _page(
                "https://jobs.example/role",
                "Role",
                "A 110x team in a fast-paced, world-class org. Also a 10x ninja and rock-star. "
                "We are disruptive and love synergies. Unlimited-PTO.",
            ),
            _page("https://example.com/docs", "Docs", "python"),
        ]
    )
    assert report["buzzwords"] == [
        "world class",
        "fast paced",
        "ninja",
        "rockstar",
        "disrupt",
        "synergy",
        "10x",
        "unlimited pto",
    ]


def test_tech_detection_skips_accidental_suffixes() -> None:
    report = build_report(
        [
            _page(
                "https://jobs.example/role",
                "Role",
                "We need banjos and nosql and go and c# and node.js daily.",
            ),
            _page("https://example.com/product", "Product", "subjects and music"),
        ]
    )
    assert "banjos" not in report["jd_tech"]
    assert "subjects" not in report["product_tech"]
    assert report["jd_tech"] == ["c#", "go", "node.js", "nosql"]


def test_published_tech_lists_are_capped_and_missing_list_is_not() -> None:
    names = [
        "python",
        "java",
        "typescript",
        "javascript",
        "golang",
        "rust",
        "react",
        "nextjs",
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
    ]
    report = build_report(
        [
            _page("https://jobs.example/role", "Role", " ".join(names)),
            _page("https://example.com/product", "Product", "hello product surface"),
        ]
    )
    assert report["jd_tech"] == sorted(names)[:24]
    assert len(report["listed_in_jd_missing_on_site"]) == len(names)
    markdown = render_markdown(report)
    assert ", ".join(report["jd_tech"]) in markdown
    assert sorted(names)[24] not in report["jd_tech"]


def test_control_characters_cannot_break_the_markdown_report() -> None:
    report = build_report(
        [
            _page("https://jobs.example/role\n# injected", "Role\n## pwn", "python kubernetes"),
            _page("https://example.com/docs", "Docs", "python"),
        ]
    )
    markdown = render_markdown(report)
    assert markdown.startswith("# Apply Lens report\n")
    assert "\n# injected" not in markdown
    assert "\n## pwn" not in markdown
    assert "\n" not in report["job_title"]
    assert "\n" not in report["job_url"]


def test_null_text_is_empty_and_non_strings_are_rejected() -> None:
    empty = build_report(
        [
            {"url": "https://jobs.example/role", "title": "Role", "text": None},
            _page("https://example.com/docs", "Docs", "python"),
        ]
    )
    assert empty["pages_captured"][0]["chars"] == 0
    with pytest.raises(ScoreError, match="text must be a string"):
        build_report([{"url": "https://jobs.example/role", "title": "Role", "text": 12}])


def test_page_files_sort_numerically_and_ignore_other_names(tmp_path: Path) -> None:
    _write_page(
        tmp_path,
        "page-10.json",
        _page("https://example.com/product", "Product", "python sandbox"),
    )
    _write_page(
        tmp_path,
        "page-2.json",
        _page("https://jobs.example/role", "Role", "kubernetes kafka"),
    )
    (tmp_path / "page-notes.json").write_text("{", encoding="utf-8")
    (tmp_path / "notes.json").write_text("[]", encoding="utf-8")
    pages = load_pages(tmp_path)
    assert [page["url"] for page in pages] == [
        "https://jobs.example/role",
        "https://example.com/product",
    ]


def test_load_pages_rejects_bad_captures(tmp_path: Path) -> None:
    secret = "slr_live_" + ("a" * 20)
    (tmp_path / "page-00.json").write_text("{" + secret, encoding="utf-8")
    with pytest.raises(ScoreError, match="invalid JSON") as caught:
        load_pages(tmp_path)
    assert secret not in str(caught.value)

    _write_page(tmp_path, "page-00.json", ["not", "an", "object"])
    with pytest.raises(ScoreError, match="JSON object"):
        load_pages(tmp_path)

    (tmp_path / "page-00.json").write_bytes(b"\xff\xfe")
    with pytest.raises(ScoreError, match="not valid UTF-8"):
        load_pages(tmp_path)


def test_load_pages_rejects_symlinks_and_special_files(tmp_path: Path) -> None:
    outside = tmp_path / "outside.json"
    outside.write_text(
        json.dumps(_page("https://jobs.example/role", "Role", "python")),
        encoding="utf-8",
    )
    link = tmp_path / "page-00.json"
    link.symlink_to(outside)
    with pytest.raises(ScoreError, match="refusing to follow a symlink"):
        load_pages(tmp_path)

    link.unlink()
    nested = tmp_path / "page-00.json"
    nested.mkdir()
    with pytest.raises(ScoreError, match="not a regular file"):
        load_pages(tmp_path)


def test_load_pages_rejects_oversized_files_and_too_many_pages(tmp_path: Path) -> None:
    huge = tmp_path / "page-00.json"
    huge.write_bytes(b"{" + (b" " * MAX_PAGE_BYTES))
    with pytest.raises(ScoreError, match="exceeds"):
        load_pages(tmp_path)

    huge.unlink()
    for index in range(MAX_PAGES + 1):
        _write_page(
            tmp_path,
            f"page-{index}.json",
            _page(f"https://jobs.example/{index}", "Role", "python"),
        )
    with pytest.raises(ScoreError, match="too many captured pages"):
        load_pages(tmp_path)


def test_missing_directory_and_symlink_root_have_clear_errors(tmp_path: Path) -> None:
    missing = tmp_path / "missing"
    with pytest.raises(ScoreError, match="not found"):
        load_pages(missing)

    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    with pytest.raises(ScoreError, match="must not be a symlink"):
        load_pages(link)

    not_dir = tmp_path / "file"
    not_dir.write_text("nope", encoding="utf-8")
    with pytest.raises(ScoreError, match="not a directory"):
        load_pages(not_dir)


def test_text_is_truncated_to_the_browser_cap() -> None:
    report = build_report(
        [
            _page("https://jobs.example/role", "Role", "python " + ("x" * 30_000)),
            _page("https://example.com/docs", "Docs", "python"),
        ]
    )
    assert report["pages_captured"][0]["chars"] == 24_000


def test_write_reports_replaces_symlinks_and_is_private(tmp_path: Path) -> None:
    _write_page(tmp_path, "page-00.json", _page("https://jobs.example/role", "Role", "python"))
    _write_page(tmp_path, "page-01.json", _page("https://example.com/docs", "Docs", "python"))
    report = build_report(load_pages(tmp_path))
    secret = tmp_path / "secret.txt"
    secret.write_text("do-not-touch", encoding="utf-8")
    link = tmp_path / "report.json"
    link.symlink_to(secret)
    write_reports(tmp_path, report)
    assert secret.read_text(encoding="utf-8") == "do-not-touch"
    assert not link.is_symlink()
    written = json.loads(link.read_text(encoding="utf-8"))
    assert written["support_score"] == report["support_score"]
    mode = stat.S_IMODE(link.stat().st_mode)
    assert mode == 0o600
    markdown = tmp_path / "report.md"
    assert stat.S_IMODE(markdown.stat().st_mode) == 0o600
    assert markdown.read_text(encoding="utf-8").startswith("# Apply Lens report\n")


def test_fixture_json_escapes_non_ascii(tmp_path: Path) -> None:
    for path in sorted(FIXTURES.glob("page-*.json")):
        (tmp_path / path.name).write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    main(["--root", str(tmp_path)])
    raw = (tmp_path / "report.json").read_text(encoding="utf-8")
    assert r"\u2014" in raw
    assert not raw.endswith("\n")


def test_main_prints_markdown_and_errors_for_a_missing_root(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    for path in sorted(FIXTURES.glob("page-*.json")):
        (tmp_path / path.name).write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    main(["--root", str(tmp_path)])
    printed = capsys.readouterr().out
    assert printed.startswith("# Apply Lens report\n")
    assert "**Support score:** 7.8  \n" in printed

    with pytest.raises(SystemExit, match="not found"):
        main(["--root", str(tmp_path / "missing")])


def test_parse_args_uses_flag_then_environment_then_sandbox_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("APPLY_LENS_ROOT", raising=False)
    assert parse_args([]).root == Path("/tmp/apply-lens")  # noqa: S108
    monkeypatch.setenv("APPLY_LENS_ROOT", "/var/tmp/captures")  # noqa: S108
    assert parse_args([]).root == Path("/var/tmp/captures")  # noqa: S108
    assert parse_args(["--root", "captures"]).root == Path("captures")


def test_cli_subprocess_scores_a_directory(tmp_path: Path) -> None:
    for path in sorted(FIXTURES.glob("page-*.json")):
        (tmp_path / path.name).write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    completed = subprocess.run(  # noqa: S603
        [sys.executable, str(ROOT / "src" / "score.py"), "--root", str(tmp_path)],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0
    assert "Support score:** 7.8" in completed.stdout
    written = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert written["support_score"] == 7.8


def test_cli_subprocess_rejects_a_missing_directory(tmp_path: Path) -> None:
    completed = subprocess.run(  # noqa: S603
        [sys.executable, str(ROOT / "src" / "score.py"), "--root", str(tmp_path / "nope")],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode != 0
    assert "not found" in completed.stderr


def test_credentials_are_removed_from_report_urls() -> None:
    report = build_report(
        [
            _page("https://user:s3cret@jobs.example/role", "Role", "python kubernetes"),
            _page("https://example.com/docs", "Docs", "python"),
        ]
    )
    assert report["job_url"] == "https://jobs.example/role"
    assert "s3cret" not in render_markdown(report)


def test_host_spelling_and_default_port_do_not_double_count_a_page() -> None:
    report = build_report(
        [
            _page("https://jobs.example/role", "Role", "Kubernetes and Kafka"),
            _page("HTTPS://EXAMPLE.com:443/docs/", "Docs", "Python sandbox"),
            _page("https://example.com/docs", "Again", "extra python that is not a second page"),
        ]
    )
    assert [page["url"] for page in report["pages_captured"]] == [
        "https://jobs.example/role",
        "HTTPS://EXAMPLE.com:443/docs/",
    ]
    assert report["product_tech"] == ["python", "sandbox"]


def test_bidi_controls_cannot_spoof_the_title() -> None:
    report = build_report(
        [
            _page("https://jobs.example/role", "Role\u202e\u202d hidden", "python"),
            _page("https://example.com/docs", "Docs", "python"),
        ]
    )
    assert "\u202e" not in report["job_title"]
    assert "\u202d" not in report["job_title"]
    assert "hidden" in report["job_title"]
    assert "\u202e" not in render_markdown(report)


def test_duplicate_page_index_is_rejected(tmp_path: Path) -> None:
    _write_page(tmp_path, "page-0.json", _page("https://jobs.example/role", "Role", "python"))
    _write_page(tmp_path, "page-00.json", _page("https://example.com/docs", "Docs", "python"))
    with pytest.raises(ScoreError, match="duplicate page index"):
        load_pages(tmp_path)


def test_score_fixtures_script_ignores_a_planted_shared_directory(tmp_path: Path) -> None:
    shared = Path("/tmp/apply-lens")  # noqa: S108
    aside = tmp_path / "aside"
    moved = False
    if shared.exists() or shared.is_symlink():
        shared.rename(aside)
        moved = True
    shared.mkdir()
    (shared / "page-99.json").write_text(
        json.dumps(_page("https://evil.example/planted", "x", "kubernetes")),
        encoding="utf-8",
    )
    (shared / "secret.txt").write_text("do-not-touch", encoding="utf-8")
    try:
        completed = subprocess.run(  # noqa: S603
            ["sh", str(ROOT / "scripts" / "score-fixtures.sh")],  # noqa: S607
            check=False,
            capture_output=True,
            text=True,
            cwd=ROOT,
        )
        assert completed.returncode == 0, completed.stderr
        assert "Support score:** 7.8" in completed.stdout
        assert "evil.example" not in completed.stdout
        assert (shared / "secret.txt").read_text(encoding="utf-8") == "do-not-touch"
        assert not (shared / "report.json").exists()
    finally:
        for child in shared.iterdir():
            child.unlink()
        shared.rmdir()
        if moved:
            aside.rename(shared)


def test_unreadable_directory_is_reported(tmp_path: Path) -> None:
    if os.geteuid() == 0:
        pytest.skip("root bypasses directory permissions")
    blocked = tmp_path / "blocked"
    blocked.mkdir()
    _write_page(blocked, "page-00.json", _page("https://jobs.example/role", "Role", "python"))
    blocked.chmod(0)
    try:
        with pytest.raises(ScoreError, match="could not read capture directory"):
            load_pages(blocked)
    finally:
        blocked.chmod(0o700)
