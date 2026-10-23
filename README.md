# Apply Lens

[![CI](https://github.com/mangeshraut712/apply-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/mangeshraut712/apply-lens/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/Python-3-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Solari](https://img.shields.io/badge/Solari-browser%20%2B%20sandbox-0F172A)](https://docs.getsolari.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Job postings are marketing. The live product is the evidence.

**Demo:** this is a CLI — [run it locally](#run). There is no separate GitHub Pages site; the homepage is this README.

Apply Lens opens a **stealth Solari cloud browser** (residential US egress, session recording), reads a posting the way a candidate would, opens the company site, follows a few product and docs links there, then scores the JD against that capture inside a **Solari sandbox**. The report tells you what the company actually ships, which JD skills never appear on the site, and interview questions grounded in the live pages.

Built for the [Pinetree / Solari SWE intern challenge](https://x.com/harrychow_/status/2094437473912844480) by [Mangesh Raut](https://mangeshraut712.github.io/mangeshrautarchive/).

<img src="docs/screenshots/01-cli-run.png" alt="Apply Lens CLI: stealth browser capture then sandbox report with a 7.8 support score" width="900" />

<p>
<img src="docs/screenshots/02-report.png" alt="Apply Lens report: JD tech vs live-site tech, missing skills, interview questions" width="440" />
&nbsp;
<img src="docs/screenshots/03-report-json.png" alt="Apply Lens report.json from the sandbox scorer" width="440" />
</p>

<sub>Screenshots from a real <code>src/score.py</code> run against <a href="docs/fixtures/">docs/fixtures</a> (the same scorer the Solari sandbox executes). Replay with <code>npm run score:fixtures</code> — no API key required.</sub>

## Why this, not a resume

People waste weeks applying to roles whose public product does not match the posting. I wanted something I would use this week: paste a URL, get a truth report, decide whether to apply.

Harry asked for a use case people truly need. This is that.

## What Solari is doing here

| Piece | Why a laptop browser is not enough |
| --- | --- |
| `@solarisdk/browser` stealth + `proxy: "us"` | Careers and docs sites often treat datacenter crawlers differently than a person at home |
| Session recording | Replay the exact pages the score was built from |
| `@solarisdk/sdk` sandbox | Untrusted scoring code and captured pages stay off your machine |

Cookbook fork: https://github.com/mangeshraut712/solari-cookbook

## Run

```bash
# key from https://console.getsolari.com  (docs: http://docs.getsolari.com)
export SOLARI_API_KEY=slr_live_...

npm install
npx tsx index.ts --url https://docs.getsolari.com
```

If the posting is on a job board and the product is elsewhere:

```bash
npx tsx index.ts --url 'https://job-board.example/role' --company https://docs.getsolari.com
```

With no `--company`, the company page is the posting's origin. That page is opened in addition to the posting. Apply Lens then follows up to three links on the company site whose path looks like docs, product, pricing, changelog, blog, about, careers, engineering, SDK, or API — including links the posting itself makes to that site. A redirect that leaves the requested host is not captured. A bare URL without `--url`, or a repeated flag, is an error.

Score the checked-in fixtures without Solari (same Python the sandbox runs). Scoring uses a private temporary directory, so a leftover or symlinked `/tmp/apply-lens` cannot change the result:

```bash
npm run score:fixtures
```

## Output

- Support score: token overlap between the posting and live pages
- Tech in the JD vs tech on the site
- Skills listed in the posting that never appear on the product
- Buzzwords in the posting (included in the markdown report and in `report.json`)
- Interview questions derived from the live site, not from the JD template

## Stack

TypeScript, Playwright-compatible Solari browsers, Python 3 in a Solari microVM.
