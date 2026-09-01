#!/usr/bin/env python3
"""Score a job description against live product pages captured in this sandbox."""
from __future__ import annotations

import json
import re
from pathlib import Path

STOP = {
    "the", "and", "for", "with", "that", "this", "from", "your", "you",
    "are", "our", "will", "have", "has", "was", "were", "been", "being",
    "into", "onto", "over", "under", "about", "than", "then", "them",
    "they", "their", "there", "here", "what", "when", "where", "which",
    "who", "how", "why", "not", "but", "can", "all", "any", "more",
    "most", "other", "also", "just", "like", "use", "using", "used",
    "work", "working", "role", "team", "join", "across", "within",
    "including", "plus", "etc", "via", "per", "each", "both",
}

TECH = {
    "python", "java", "typescript", "javascript", "golang", "rust", "c++",
    "react", "nextjs", "next.js", "vue", "node", "fastapi", "django",
    "spring", "aws", "gcp", "azure", "kubernetes", "docker", "terraform",
    "postgres", "postgresql", "mysql", "redis", "mongodb", "kafka",
    "graphql", "grpc", "playwright", "puppeteer", "llm", "rag", "mcp",
    "agent", "agents", "sandbox", "browser", "chrome", "cdp",
}


def tokens(text: str) -> set[str]:
    words = re.findall(r"[a-z0-9][a-z0-9.+#-]{1,}", text.lower())
    return {w.strip(".") for w in words if len(w) > 2 and w not in STOP}


def load_pages(root: Path) -> list[dict]:
    pages = []
    for path in sorted(root.glob("page-*.json")):
        pages.append(json.loads(path.read_text()))
    return pages


def main() -> None:
    root = Path("/tmp/apply-lens")
    pages = load_pages(root)
    if not pages:
        raise SystemExit("no captured pages")

    jd = pages[0]
    product = pages[1:]
    jd_text = jd.get("text", "")
    product_text = "\n".join(p.get("text", "") for p in product) or jd_text
    jd_tok = tokens(jd_text)
    prod_tok = tokens(product_text)

    jd_tech = sorted(w for w in jd_tok if w in TECH or w.endswith("js") or w.endswith("sql"))
    prod_tech = sorted(w for w in prod_tok if w in TECH or w.endswith("js") or w.endswith("sql"))
    missing_on_product = sorted(set(jd_tech) - set(prod_tech))
    extra_on_product = sorted(set(prod_tech) - set(jd_tech))

    overlap = jd_tok & prod_tok
    denom = max(len(jd_tok), 1)
    support = round(100 * len(overlap) / denom, 1)

    buzz = []
    for phrase in (
        "world class",
        "fast paced",
        "ninja",
        "rockstar",
        "disrupt",
        "synergy",
        "10x",
        "unlimited pto",
    ):
        if phrase in jd_text.lower():
            buzz.append(phrase)

    questions = []
    if prod_tech:
        questions.append(
            f"Walk me through how you use {prod_tech[0]} in production, not in a take-home."
        )
    if missing_on_product:
        questions.append(
            f"The posting lists {missing_on_product[0]} but the live site does not. Where does that work actually live?"
        )
    questions.append("What would a new hire ship in week one that a customer would notice?")
    questions.append("Which metric tells you this product has product-market fit?")

    report = {
        "job_url": jd.get("url"),
        "job_title": jd.get("title"),
        "pages_captured": [
            {"url": p.get("url"), "title": p.get("title"), "chars": len(p.get("text", ""))}
            for p in pages
        ],
        "support_score": support,
        "jd_tech": jd_tech[:24],
        "product_tech": prod_tech[:24],
        "listed_in_jd_missing_on_site": missing_on_product,
        "on_site_not_in_jd": extra_on_product,
        "buzzwords": buzz,
        "interview_questions": questions,
        "verdict": (
            "JD and live product roughly agree."
            if support >= 18 and len(missing_on_product) <= 3
            else "JD and live product diverge — read the site before you apply."
        ),
    }
    out = root / "report.json"
    out.write_text(json.dumps(report, indent=2))
    md = [
        "# Apply Lens report",
        "",
        f"**Posting:** {report['job_title']}  ",
        f"**URL:** {report['job_url']}  ",
        f"**Support score:** {support}  ",
        f"**Verdict:** {report['verdict']}",
        "",
        "## Tech listed in the posting",
        ", ".join(jd_tech) or "_(none detected)_",
        "",
        "## Tech visible on the live site",
        ", ".join(prod_tech) or "_(none detected)_",
        "",
        "## In the JD, missing from the site",
        ", ".join(missing_on_product) or "_(none)_",
        "",
        "## On the site, missing from the JD",
        ", ".join(extra_on_product) or "_(none)_",
        "",
        "## Interview questions from the live product",
    ]
    md.extend(f"- {q}" for q in questions)
    (root / "report.md").write_text("\n".join(md) + "\n")
    print((root / "report.md").read_text())


if __name__ == "__main__":
    main()
