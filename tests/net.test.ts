import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readArgs } from "../src/args.js"
import {
  assertLandedUrl,
  assertPublicHttpUrl,
  classifyRequest,
  oneLine,
  planFollows,
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
    assert.equal(
      assertPublicHttpUrl("http://[2002:808:808::]/", "--url"),
      "http://[2002:808:808::]/",
    )
    assert.equal(
      assertPublicHttpUrl("http://[64:ff9b::808:808]/", "--url"),
      "http://[64:ff9b::808:808]/",
    )
    assert.equal(assertPublicHttpUrl("http://8-8-8-8.nip.io/", "--url"), "http://8-8-8-8.nip.io/")
    assert.equal(
      assertPublicHttpUrl("http://[2001:0:101:101::f7f7:f7f7]/", "--url"),
      "http://[2001:0:101:101::f7f7:f7f7]/",
    )
  })

  it("rejects transition addresses and DNS names that point at private hosts", () => {
    const rejected = [
      "http://[2002:7f00:1::]/",
      "http://[2002:a9fe:a9fe::]/",
      "http://[64:ff9b::7f00:1]/",
      "http://[64:ff9b::a9fe:a9fe]/",
      "http://[64:ff9b:1::7f00:1]/",
      "http://[::7f00:1]/",
      "http://[2001:0:808:808::80ff:fffe]/",
      "http://[fec0::1]/",
      "http://10-0-0-1.nip.io/",
      "http://pre-10-0-0-1.nip.io/",
      "http://7f000001.nip.io/",
      "http://customer-7f000001.nip.io/",
      "http://127-0-0-1.sslip.io/",
      "http://localtest.me/",
      "http://foo.localtest.me/",
      "http://lvh.me/",
      "http://foo.test/",
      "http://foo.invalid/",
      "http://foo.example/",
      "http://foo.home/",
      "http://intranet.corp/",
    ]
    for (const url of rejected) {
      assert.throws(() => assertPublicHttpUrl(url, "--url"), UrlRejected, url)
      assert.equal(classifyRequest(url), "block", url)
    }
  })
})

describe("assertLandedUrl", () => {
  it("allows the same host and an http to https upgrade", () => {
    assert.equal(
      assertLandedUrl("https://example.com/jobs/1", "https://example.com/jobs/1#apply"),
      "https://example.com/jobs/1",
    )
    assert.equal(
      assertLandedUrl("http://example.com/jobs/1", "https://example.com/jobs/1"),
      "https://example.com/jobs/1",
    )
  })

  it("rejects an open redirect onto another host or a private address", () => {
    assert.throws(
      () => assertLandedUrl("https://jobs.example/role", "https://evil.example/phish"),
      UrlRejected,
    )
    assert.throws(
      () => assertLandedUrl("https://example.com/jobs", "http://169.254.169.254/"),
      UrlRejected,
    )
    assert.throws(
      () => assertLandedUrl("https://example.com/jobs", "http://[2002:7f00:1::]/"),
      UrlRejected,
    )
  })
})

describe("planFollows", () => {
  it("follows company-site links from a job board and skips the board", () => {
    const job = "https://jobs.example.com/staff-platform-engineer"
    const company = "https://docs.getsolari.com/"
    const follows = planFollows(
      job,
      company,
      [
        {
          url: job,
          links: [
            "https://docs.getsolari.com",
            "https://docs.getsolari.com/product",
            "https://docs.getsolari.com/sdk",
            "https://jobs.example.com/docs/benefits",
          ],
        },
        {
          url: company,
          links: [
            "https://docs.getsolari.com/sdk#install",
            "https://docs.getsolari.com/changelog",
          ],
        },
      ],
      3,
    )
    assert.deepEqual(follows, [
      "https://docs.getsolari.com/product",
      "https://docs.getsolari.com/sdk",
      "https://docs.getsolari.com/changelog",
    ])
  })

  it("keeps three same-origin product links when the homepage is separate", () => {
    const job = "https://docs.example.com/jobs/1"
    const follows = planFollows(
      job,
      "https://docs.example.com/",
      [
        {
          url: job,
          links: [
            "https://docs.example.com/docs/intro",
            "https://docs.example.com/pricing",
            "https://docs.example.com/blog/hello",
            "https://docs.example.com/about",
            "https://docs.example.com/random?topic=blog",
          ],
        },
      ],
      3,
    )
    assert.deepEqual(follows, [
      "https://docs.example.com/docs/intro",
      "https://docs.example.com/pricing",
      "https://docs.example.com/blog/hello",
    ])
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
    assert.equal(oneLine("\u001b[31mhidden\u001b[0m\u202eevil", secret), "hiddenevil")
  })

  it("reads split and inline flags and rejects missing values", () => {
    assert.deepEqual(readArgs(["--url", "https://example.com/jobs/1"]), {
      jobUrl: "https://example.com/jobs/1",
      companyUrl: "https://example.com/",
      companyFromFlag: false,
    })
    assert.equal(
      readArgs(["--url", "https://example.com/jobs/1", "--company", "https://docs.example.com/"])
        .companyFromFlag,
      true,
    )
    assert.equal(
      readArgs(["--url=https://docs.getsolari.com/sdk"]).jobUrl,
      "https://docs.getsolari.com/sdk",
    )
    assert.throws(() => readArgs(["--url"]), /--url requires a URL value/)
    assert.throws(() => readArgs(["--url", "--company"]), /--url requires a URL value/)
    assert.throws(() => readArgs(["--company", "http://127.0.0.1"]), UrlRejected)
    assert.throws(
      () => readArgs(["--url", "https://example.com/a", "--url", "https://example.com/b"]),
      /--url was provided more than once/,
    )
    assert.throws(() => readArgs(["--comapny", "https://example.com/"]), /unknown argument/)
    assert.throws(() => readArgs(["https://example.com/jobs/1"]), /unexpected argument/)
  })

  it("uses the documented default posting when no flag is present", () => {
    assert.equal(readArgs([]).jobUrl, "https://docs.getsolari.com/")
    assert.equal(readArgs([]).companyUrl, "https://docs.getsolari.com/")
  })
})
