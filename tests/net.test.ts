import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readArgs } from "../src/args.js"
import {
  assertPublicHttpUrl,
  classifyRequest,
  oneLine,
  redactSecrets,
  shouldFollow,
  UrlRejected,
} from "../src/net.js"

const ORIGIN = "https://docs.example.com"

describe("assertPublicHttpUrl", () => {
  it("accepts public http(s) URLs and drops the fragment", () => {
    assert.equal(
      assertPublicHttpUrl("https://docs.getsolari.com/docs", "--url"),
      "https://docs.getsolari.com/docs",
    )
    assert.equal(
      assertPublicHttpUrl("https://example.com/path#frag", "--url"),
      "https://example.com/path",
    )
    assert.equal(assertPublicHttpUrl("http://8.8.8.8/job", "--url"), "http://8.8.8.8/job")
    assert.equal(
      assertPublicHttpUrl("http://[2001:4860:4860::8888]/", "--url"),
      "http://[2001:4860:4860::8888]/",
    )
  })

  it("rejects non-http protocols, credentials, and local targets", () => {
    const rejected = [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:pass@example.com/a",
      "https://docs.getsolari.com@evil.com/",
      "http://localhost/jobs",
      "http://127.0.0.1/",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0177.0.0.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:7f00:1]/",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://metadata.google.internal/",
      "http://127.0.0.1.nip.io/",
      "http://printer.local/jobs",
      "http://intranet/jobs",
      "https://example.com/path\n",
    ]
    for (const url of rejected) {
      assert.throws(() => assertPublicHttpUrl(url, "--url"), UrlRejected, url)
    }
  })

  it("allows a public address just outside the private ranges", () => {
    assert.equal(assertPublicHttpUrl("http://172.32.0.1/", "--url"), "http://172.32.0.1/")
    assert.equal(assertPublicHttpUrl("http://11.0.0.1/", "--url"), "http://11.0.0.1/")
  })
})

describe("classifyRequest", () => {
  it("allows benign browser URLs and public subresources", () => {
    assert.equal(classifyRequest("about:blank"), "allow")
    assert.equal(classifyRequest("data:text/plain,hello"), "allow")
    assert.equal(classifyRequest("https://cdn.example.com/app.js"), "allow")
  })

  it("blocks private and unexpected protocols", () => {
    assert.equal(classifyRequest("http://169.254.169.254/"), "block")
    assert.equal(classifyRequest("file:///etc/passwd"), "block")
    assert.equal(classifyRequest("ws://127.0.0.1/socket"), "block")
    assert.equal(classifyRequest("not a url"), "block")
  })
})

describe("shouldFollow", () => {
  it("follows same-origin product paths and ignores query-only hints", () => {
    assert.equal(shouldFollow("https://docs.example.com/docs/intro", ORIGIN), true)
    assert.equal(shouldFollow("https://docs.example.com/pricing?x=1", ORIGIN), true)
    assert.equal(shouldFollow("https://docs.example.com/random?topic=blog", ORIGIN), false)
    assert.equal(shouldFollow("https://evil.example/docs", ORIGIN), false)
    assert.equal(shouldFollow("https://user:pass@docs.example.com/docs", ORIGIN), false)
    assert.equal(shouldFollow("javascript:alert(1)", ORIGIN), false)
  })
})

describe("redaction and args", () => {
  it("redacts the API key and flattens log lines", () => {
    const secret = "slr_live_example_key"
    assert.equal(redactSecrets(`key ${secret} in\ntext`, secret), "key [redacted] in\ntext")
    assert.equal(oneLine(`skip\n${secret}`, secret), "skip [redacted]")
  })

  it("reads split and inline flags and rejects missing values", () => {
    assert.deepEqual(readArgs(["--url", "https://example.com/jobs/1"]), {
      jobUrl: "https://example.com/jobs/1",
      companyUrl: "https://example.com/",
    })
    assert.equal(
      readArgs(["--url=https://docs.getsolari.com/sdk"]).jobUrl,
      "https://docs.getsolari.com/sdk",
    )
    assert.throws(() => readArgs(["--url"]), /--url requires a URL value/)
    assert.throws(() => readArgs(["--url", "--company"]), /--url requires a URL value/)
    assert.throws(() => readArgs(["--company", "http://127.0.0.1"]), UrlRejected)
  })

  it("uses the documented default posting when no flag is present", () => {
    assert.equal(readArgs([]).jobUrl, "https://docs.getsolari.com/")
    assert.equal(readArgs([]).companyUrl, "https://docs.getsolari.com/")
  })
})
