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
import { readArgs } from "./src/args.js"
import { classifyRequest, oneLine, redactSecrets, shouldFollow, stripHash } from "./src/net.js"

interface CapturedPage {
  url: string
  title: string
  text: string
  links: string[]
}

type SolariBrowser = Awaited<ReturnType<Solari["launch"]>>
type SolariPage = Awaited<ReturnType<SolariBrowser["newPage"]>>

const MAX_TEXT_CHARS = 24_000
const MAX_LINKS = 100
const MAX_FOLLOWS = 3
const NAV_TIMEOUT_MS = 30_000
const SCORE_TIMEOUT_MS = 60_000
const MAX_REPORT_CHARS = 200_000

function apiKeyFromEnv(): string {
  const apiKey = process.env.SOLARI_API_KEY?.trim()
  if (!apiKey) {
    throw new Error("Set SOLARI_API_KEY (https://console.getsolari.com)")
  }
  return apiKey
}

async function installPublicOnlyGuard(page: SolariPage): Promise<void> {
  await page.route("**/*", async (route) => {
    if (classifyRequest(route.request().url()) === "allow") {
      await route.continue()
      return
    }
    await route.abort("blockedbyclient")
  })
}

function asExtracted(value: unknown): { text: string; links: string[] } {
  if (typeof value !== "object" || value === null) {
    throw new Error("page extraction returned an unexpected value")
  }
  const record = value as { text?: unknown; links?: unknown }
  if (typeof record.text !== "string" || !Array.isArray(record.links)) {
    throw new Error("page extraction returned an unexpected value")
  }
  const links: string[] = []
  for (const link of record.links) {
    if (typeof link !== "string") {
      continue
    }
    links.push(link)
    if (links.length >= MAX_LINKS) {
      break
    }
  }
  return { text: record.text.slice(0, MAX_TEXT_CHARS), links }
}

async function capture(page: SolariPage, url: string): Promise<CapturedPage> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS })
  const title = await page.title()
  const extracted = asExtracted(
    await page.evaluate(
      ({ maxText, maxLinks }) => {
        const text = (document.body?.innerText ?? "").slice(0, maxText)
        const anchors = document.querySelectorAll("a[href]")
        const links: string[] = []
        const seen = new Set<string>()
        for (const node of anchors) {
          if (links.length >= maxLinks) {
            break
          }
          const href = (node as HTMLAnchorElement).href
          if (href.length === 0 || seen.has(href)) {
            continue
          }
          seen.add(href)
          links.push(href)
        }
        return { text, links }
      },
      { maxText: MAX_TEXT_CHARS, maxLinks: MAX_LINKS },
    ),
  )
  return {
    url: oneLine(url, undefined, 2048),
    title: oneLine(title, undefined, 300),
    text: extracted.text,
    links: extracted.links,
  }
}

async function closeQuietly(
  label: string,
  close: () => Promise<unknown>,
  secret: string,
): Promise<void> {
  try {
    await close()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "close failed"
    console.error(`${label}: ${oneLine(message, secret)}`)
  }
}

function parseReport(raw: string): unknown {
  if (raw.length > MAX_REPORT_CHARS) {
    throw new Error("sandbox report is too large")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("sandbox report was not valid JSON")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("sandbox report was not a JSON object")
  }
  return parsed
}

async function main(): Promise<void> {
  const apiKey = apiKeyFromEnv()
  const { jobUrl, companyUrl } = readArgs(process.argv)
  const here = dirname(fileURLToPath(import.meta.url))
  const scorePy = readFileSync(join(here, "src/score.py"), "utf8")

  const solari = new Solari({ apiKey })
  const cloud = new SolariClient({ apiKey })
  const pages: CapturedPage[] = []
  let browser: SolariBrowser | undefined

  try {
    browser = await solari.launch({
      stealth: true,
      proxy: "us",
      recording: true,
    })
    const page = await browser.newPage()
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS)
    page.setDefaultTimeout(NAV_TIMEOUT_MS)
    await installPublicOnlyGuard(page)
    const job = await capture(page, jobUrl)
    pages.push(job)

    const origin = new URL(jobUrl).origin
    const next = new Set<string>()
    if (companyUrl !== jobUrl) {
      next.add(companyUrl)
    }
    for (const href of job.links) {
      if (!shouldFollow(href, origin)) {
        continue
      }
      let cleaned: string
      try {
        cleaned = stripHash(href)
      } catch {
        continue
      }
      if (cleaned !== jobUrl) {
        next.add(cleaned)
      }
    }
    for (const href of [...next].slice(0, MAX_FOLLOWS)) {
      try {
        pages.push(await capture(page, href))
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "capture failed"
        console.error(`skip ${oneLine(href, apiKey)} ${oneLine(message, apiKey)}`)
      }
    }
    console.log(`session: ${oneLine(browser.id, apiKey)}`)
    console.log(`pages  : ${pages.map((item) => oneLine(item.url, apiKey)).join("\n         ")}`)
  } finally {
    const open = browser
    if (open) {
      await closeQuietly("browser", () => open.close(), apiKey)
    }
    await closeQuietly("solari", () => solari.close(), apiKey)
  }

  const sandbox = await cloud.sandboxes.create({
    template: "base",
    timeoutMs: 5 * 60_000,
  })
  try {
    await sandbox.connect()
    await sandbox.commands.run("mkdir", {
      args: ["-p", "/tmp/apply-lens"],
      timeoutMs: SCORE_TIMEOUT_MS,
    })
    await sandbox.files.write("/tmp/apply-lens/score.py", scorePy)
    for (const [index, captured] of pages.entries()) {
      await sandbox.files.write(
        `/tmp/apply-lens/page-${String(index).padStart(2, "0")}.json`,
        JSON.stringify(captured),
      )
    }
    const scored = await sandbox.commands.run("python3", {
      args: ["/tmp/apply-lens/score.py"],
      timeoutMs: SCORE_TIMEOUT_MS,
    })
    if (scored.exitCode !== 0) {
      throw new Error(oneLine(scored.stderr || `sandbox score failed (${scored.exitCode})`, apiKey))
    }
    console.log(redactSecrets(scored.stdout, apiKey))
    const reportRaw = await sandbox.files.readText("/tmp/apply-lens/report.json")
    parseReport(reportRaw)
    console.log("report.json")
    console.log(redactSecrets(reportRaw, apiKey))
  } finally {
    await closeQuietly("sandbox", () => sandbox.kill(), apiKey)
  }
}

main().catch((err: unknown) => {
  const secret = process.env.SOLARI_API_KEY ?? ""
  const message = err instanceof Error ? err.message : "unexpected failure"
  console.error(oneLine(message, secret))
  process.exitCode = 1
})
