import { assertPublicHttpUrl, oneLine } from "./net.js"

export interface LensArgs {
  jobUrl: string
  companyUrl: string
  /** False when companyUrl was derived from the posting origin. */
  companyFromFlag: boolean
}

export function readArgs(argv: readonly string[]): LensArgs {
  rejectUnexpected(argv)
  const jobRaw = flagValue(argv, "--url") ?? "https://docs.getsolari.com"
  const jobUrl = assertPublicHttpUrl(jobRaw, "--url")
  const companyRaw = flagValue(argv, "--company")
  if (companyRaw === undefined) {
    return {
      jobUrl,
      companyUrl: assertPublicHttpUrl(new URL(jobUrl).origin, "--company"),
      companyFromFlag: false,
    }
  }
  return {
    jobUrl,
    companyUrl: assertPublicHttpUrl(companyRaw, "--company"),
    companyFromFlag: true,
  }
}

function rejectUnexpected(argv: readonly string[]): void {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) {
      continue
    }
    if (!arg.startsWith("-")) {
      throw new Error(`unexpected argument ${oneLine(arg, undefined, 80)}`)
    }
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg
    if (flag !== "--url" && flag !== "--company") {
      throw new Error(`unknown argument ${oneLine(flag, undefined, 80)}`)
    }
    if (!arg.includes("=")) {
      const value = argv[index + 1]
      if (value !== undefined && !value.startsWith("-")) {
        index += 1
      }
    }
  }
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const inline = `${flag}=`
  let found: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) {
      continue
    }
    let value: string | undefined
    if (arg === flag) {
      value = argv[index + 1]
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`${flag} requires a URL value`)
      }
    } else if (arg.startsWith(inline)) {
      value = arg.slice(inline.length)
      if (value.length === 0) {
        throw new Error(`${flag} requires a URL value`)
      }
    }
    if (value === undefined) {
      continue
    }
    if (found !== undefined) {
      throw new Error(`${flag} was provided more than once`)
    }
    found = value
  }
  return found
}
