import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { MAX_REPORT_CHARS, parseReport } from "../src/report.js"

describe("parseReport", () => {
  it("returns the parsed report object untouched", () => {
    const report = { verdict: "strong-match", evidence: ["page-00"], score: 4 }
    assert.deepEqual(parseReport(JSON.stringify(report)), report)
  })

  it("rejects valid JSON that is not an object", () => {
    for (const raw of ["[]", "null", "42", '"text"', "true"]) {
      assert.throws(() => parseReport(raw), /was not a JSON object/, raw)
    }
  })

  it("rejects output that is not JSON", () => {
    assert.throws(() => parseReport(""), /was not valid JSON/)
    assert.throws(() => parseReport("verdict: strong-match"), /was not valid JSON/)
    assert.throws(() => parseReport('{"score": 4,}'), /was not valid JSON/)
  })

  it("enforces the size cap before parsing", () => {
    const oversized = `{"pad":"${"x".repeat(MAX_REPORT_CHARS)}"}`
    assert.throws(() => parseReport(oversized), /too large/)
    // The size guard wins over parse errors, so a hostile multi-megabyte blob
    // never reaches JSON.parse.
    assert.throws(() => parseReport("x".repeat(MAX_REPORT_CHARS + 1)), /too large/)
  })

  it("accepts a report exactly at the size cap", () => {
    const overhead = `{"pad":""}`.length
    const raw = `{"pad":"${"x".repeat(MAX_REPORT_CHARS - overhead)}"}`
    assert.equal(raw.length, MAX_REPORT_CHARS)
    const parsed = parseReport(raw) as { pad: string }
    assert.equal(parsed.pad.length, MAX_REPORT_CHARS - overhead)
  })
})
