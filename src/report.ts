/** Upper bound for the scorer report read back from the sandbox. */
export const MAX_REPORT_CHARS = 200_000

export function parseReport(raw: string): unknown {
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
