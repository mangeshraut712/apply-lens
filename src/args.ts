import { assertPublicHttpUrl } from "./net.js"

export interface LensArgs {
  jobUrl: string
  companyUrl: string
}

export function readArgs(argv: readonly string[]): LensArgs {
  const jobRaw = flagValue(argv, "--url") ?? "https://docs.getsolari.com"
  const jobUrl = assertPublicHttpUrl(jobRaw, "--url")
  const companyRaw = flagValue(argv, "--company") ?? new URL(jobUrl).origin
  const companyUrl = assertPublicHttpUrl(companyRaw, "--company")
  return { jobUrl, companyUrl }
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const inline = `${flag}=`
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) {
      continue
    }
    if (arg === flag) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`${flag} requires a URL value`)
      }
      return value
    }
    if (arg.startsWith(inline)) {
      const value = arg.slice(inline.length)
      if (value.length === 0) {
        throw new Error(`${flag} requires a URL value`)
      }
      return value
    }
  }
  return undefined
}
