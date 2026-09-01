/**
 * Apply Lens — job posts lie in the abstract. Live product pages do not.
 *
 * A stealth Solari browser opens the posting the way a candidate would,
 * follows a few same-origin product/docs links, then a Solari sandbox
 * scores the JD against what the company actually ships.
 *
 *   export SOLARI_API_KEY=slr_live_...
 *   npx tsx index.ts --url https://docs.getsolari.com
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Solari } from "@solarisdk/browser"
import { SolariClient } from "@solarisdk/sdk"

type CapturedPage = {
  url: string
  title: string
  text: string
  links: string[]
}

const FOLLOW_HINTS = [
  "doc",
  "product",
  "platform",
  "pricing",
  "changelog",
  "blog",
  "about",
  "career",
  "engineer",
  "sdk",
  "api",
]

function argValue(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag)
  if (idx === -1 || idx === process.argv.length - 1) {
    return fallback
  }
  return process.argv[idx + 1]!
}

function originOf(url: string): string {
  return new URL(url).origin
}

function shouldFollow(href: string, origin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(href)
  } catch {
    return false
  }
  if (parsed.origin !== origin) {
    return false
  }
  const hay = `${parsed.pathname} ${parsed.search}`.toLowerCase()
  return FOLLOW_HINTS.some((hint) => hay.includes(hint))
}

async function capture(
  page: {
    goto: (
      url: string,
      opts?: { waitUntil?: "domcontentloaded" | "load" | "networkidle" },
    ) => Promise<unknown>
    title: () => Promise<string>
    evaluate: (fn: () => unknown) => Promise<unknown>
  },
  url: string,
): Promise<CapturedPage> {
  await page.goto(url, { waitUntil: "domcontentloaded" })
  const title = await page.title()
  const extracted = (await page.evaluate(() => {
    const text = document.body?.innerText ?? ""
    const links = [...document.querySelectorAll("a[href]")].map(
      (a) => (a as HTMLAnchorElement).href,
    )
    return { text, links }
  })) as { text: string; links: string[] }
  return {
    url,
    title,
    text: extracted.text.slice(0, 24_000),
    links: extracted.links,
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) {
    throw new Error("Set SOLARI_API_KEY (https://console.getsolari.com)")
  }

  const jobUrl = argValue("--url", "https://docs.getsolari.com")
  const companyUrl = argValue("--company", originOf(jobUrl))
  const here = dirname(fileURLToPath(import.meta.url))
  const scorePy = readFileSync(join(here, "src/score.py"), "utf8")

  const solari = new Solari({ apiKey })
  const cloud = new SolariClient({ apiKey })
  const pages: CapturedPage[] = []

  const browser = await solari.launch({
    stealth: true,
    proxy: "us",
    recording: true,
  })
  try {
    const page = await browser.newPage()
    const job = await capture(page, jobUrl)
    pages.push(job)

    const origin = originOf(jobUrl)
    const next = new Set<string>()
    if (companyUrl !== jobUrl) {
      next.add(companyUrl)
    }
    for (const href of job.links) {
      if (shouldFollow(href, origin) && href !== jobUrl) {
        next.add(href.split("#")[0]!)
      }
    }
    for (const href of [...next].slice(0, 3)) {
      try {
        pages.push(await capture(page, href))
      } catch (err) {
        console.error("skip", href, err instanceof Error ? err.message : err)
      }
    }
    console.log("session:", browser.id)
    console.log("pages  :", pages.map((p) => p.url).join("\n         "))
  } finally {
    await browser.close()
    await solari.close()
  }

  const sandbox = await cloud.sandboxes.create({
    template: "base",
    timeoutMs: 5 * 60_000,
  })
  try {
    await sandbox.connect()
    await sandbox.commands.run("mkdir", { args: ["-p", "/tmp/apply-lens"] })
    await sandbox.files.write("/tmp/apply-lens/score.py", scorePy)
    for (const [i, captured] of pages.entries()) {
      await sandbox.files.write(
        `/tmp/apply-lens/page-${String(i).padStart(2, "0")}.json`,
        JSON.stringify(captured),
      )
    }
    const scored = await sandbox.commands.run("python3", {
      args: ["/tmp/apply-lens/score.py"],
    })
    if (scored.exitCode !== 0) {
      throw new Error(scored.stderr || `sandbox score failed (${scored.exitCode})`)
    }
    console.log(scored.stdout)
    const report = await sandbox.files.readText("/tmp/apply-lens/report.json")
    console.log("report.json")
    console.log(report)
  } finally {
    await sandbox.kill()
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
