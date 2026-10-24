/**
 * URL policy for the cloud browser.
 *
 * The browser runs off-box, so a posting or a link it contains must not be
 * able to aim the session at loopback, link-local, or metadata addresses.
 * That includes IPv4 embedded in 6to4, Teredo, NAT64, and IPv4-compatible
 * IPv6, plus public DNS names that resolve to loopback.
 */
import { BlockList, isIP } from "node:net"

const MAX_NAVIGATION_URL_LENGTH = 2048
const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "localtest.me",
  "lvh.me",
])
const BLOCKED_SUFFIXES = [
  ".local",
  ".localhost",
  ".localdomain",
  ".internal",
  ".home.arpa",
  ".lan",
  ".home",
  ".corp",
  ".localtest.me",
  ".lvh.me",
  ".test",
  ".invalid",
  ".example",
]
/** Public resolvers that answer with the IPv4 address encoded in the name. */
const WILDCARD_IP_SUFFIXES = [".nip.io", ".sslip.io", ".xip.io"]
const BENIGN_PROTOCOLS = new Set(["about:", "blob:", "data:"])
const MAX_DATA_URL_LENGTH = 1_000_000
const MAX_SUBRESOURCE_URL_LENGTH = 16_384

const BLOCK_V4 = new BlockList()
const BLOCK_V6 = new BlockList()

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCK_V4.addSubnet(network, prefix, "ipv4")
}
BLOCK_V4.addAddress("255.255.255.255", "ipv4")
BLOCK_V6.addAddress("::", "ipv6")
BLOCK_V6.addAddress("::1", "ipv6")
BLOCK_V6.addSubnet("fc00::", 7, "ipv6")
BLOCK_V6.addSubnet("fe80::", 10, "ipv6")
BLOCK_V6.addSubnet("ff00::", 8, "ipv6")
BLOCK_V6.addSubnet("2001:db8::", 32, "ipv6")
BLOCK_V6.addSubnet("fec0::", 10, "ipv6")

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

export class UrlRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UrlRejected"
  }
}

export function assertPublicHttpUrl(
  raw: string,
  label: string,
  maxLength = MAX_NAVIGATION_URL_LENGTH,
): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > maxLength) {
    throw new UrlRejected(`${label} must be an http(s) URL`)
  }
  if (/[\u0000-\u0020\u007f]/.test(raw)) {
    throw new UrlRejected(`${label} must be an http(s) URL`)
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new UrlRejected(`${label} must be an http(s) URL`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UrlRejected(`${label} must be an http(s) URL`)
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new UrlRejected(`${label} must not include credentials`)
  }
  const host = normalizeHost(parsed.hostname)
  if (host.length === 0 || isBlockedHost(host)) {
    throw new UrlRejected(`${label} must not target a local or private host`)
  }
  parsed.hash = ""
  return parsed.href
}

/**
 * Accept the URL the browser actually landed on.
 * Same-host http→https upgrades are normal. Any other host, including an
 * open redirect, is rejected so the capture cannot leave the page it was
 * allowed to open.
 */
export function assertLandedUrl(requested: string, landed: string): string {
  const normalized = assertPublicHttpUrl(landed, "navigation")
  const start = new URL(requested)
  const end = new URL(normalized)
  if (end.origin === start.origin) {
    return normalized
  }
  const sameHost = end.hostname === start.hostname && end.port === start.port
  if (start.protocol === "http:" && end.protocol === "https:" && sameHost) {
    return normalized
  }
  throw new UrlRejected("navigation left the requested host")
}

export function classifyRequest(raw: string): "allow" | "block" {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_DATA_URL_LENGTH) {
    return "block"
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return "block"
  }
  if (BENIGN_PROTOCOLS.has(parsed.protocol)) {
    return "allow"
  }
  try {
    assertPublicHttpUrl(raw, "request", MAX_SUBRESOURCE_URL_LENGTH)
    return "allow"
  } catch (err: unknown) {
    if (err instanceof UrlRejected) {
      return "block"
    }
    throw err
  }
}

export function shouldFollow(href: string, origin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(href)
  } catch {
    return false
  }
  if (parsed.origin !== origin) {
    return false
  }
  try {
    assertPublicHttpUrl(href, "link")
  } catch (err: unknown) {
    if (err instanceof UrlRejected) {
      return false
    }
    throw err
  }
  const segments = parsed.pathname.toLowerCase().split("/").filter((segment) => segment.length > 0)
  return FOLLOW_HINTS.some((hint) => segments.some((segment) => segment.includes(hint)))
}

/**
 * Product/docs links to open after the posting and, when it differs, the
 * company URL. The company page is not counted against `maxFollows`.
 * Links must stay on the company origin, so a job-board posting does not
 * spend the budget on the board itself when `--company` points elsewhere.
 */
export function planFollows(
  jobUrl: string,
  companyUrl: string,
  pages: readonly { url: string; links: readonly string[] }[],
  maxFollows: number,
): string[] {
  if (!Number.isInteger(maxFollows) || maxFollows <= 0) {
    return []
  }
  const productOrigin = new URL(companyUrl).origin
  const seen = new Set<string>([jobUrl, companyUrl])
  for (const page of pages) {
    seen.add(page.url)
  }
  const follows: string[] = []
  for (const page of pages) {
    for (const href of page.links) {
      if (follows.length >= maxFollows) {
        return follows
      }
      if (!shouldFollow(href, productOrigin)) {
        continue
      }
      let cleaned: string
      try {
        cleaned = stripHash(href)
      } catch {
        continue
      }
      if (seen.has(cleaned)) {
        continue
      }
      seen.add(cleaned)
      follows.push(cleaned)
    }
  }
  return follows
}

export function stripHash(href: string): string {
  const parsed = new URL(href)
  parsed.hash = ""
  return parsed.href
}

export function redactSecrets(message: string, secret: string | undefined): string {
  let out = message
  if (secret !== undefined && secret.length > 0) {
    out = out.split(secret).join("[redacted]")
  }
  return out.replace(/\bslr_[A-Za-z0-9_-]{6,}\b/g, "[redacted]")
}

const ANSI_OSC = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const UNSAFE_CHARS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

export function oneLine(message: string, secret?: string, limit = 500): string {
  const flat = redactSecrets(message, secret)
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(/[\r\n\t\u2028\u2029]+/g, " ")
    .replace(UNSAFE_CHARS, "")
  return flat.length > limit ? flat.slice(0, limit) : flat
}

function normalizeHost(hostname: string): string {
  let host = hostname.toLowerCase()
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1)
  }
  while (host.endsWith(".")) {
    host = host.slice(0, -1)
  }
  return host
}

function isBlockedHost(host: string): boolean {
  if (isBlockedIp(host) || embedsBlockedIpv4(host) || embedsEncodedPrivateIp(host)) {
    return true
  }
  if (isIP(host) !== 0) {
    return false
  }
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true
  }
  if (!host.includes(".")) {
    return true
  }
  if (host.length > 253 || host.includes("..")) {
    return true
  }
  return !/^[a-z0-9.-]+$/.test(host)
}

function isBlockedIp(host: string): boolean {
  const kind = isIP(host)
  if (kind === 4) {
    return BLOCK_V4.check(host, "ipv4")
  }
  if (kind === 6) {
    const mapped = ipv4FromMapped(host)
    if (mapped !== null) {
      return isIP(mapped) !== 4 || BLOCK_V4.check(mapped, "ipv4")
    }
    if (BLOCK_V6.check(host, "ipv6")) {
      return true
    }
    return embedsBlockedIpv4InIpv6(host)
  }
  return false
}

function embedsBlockedIpv4(hostname: string): boolean {
  const labels = hostname.split(".")
  for (let index = 0; index + 3 < labels.length; index += 1) {
    const candidate = labels.slice(index, index + 4).join(".")
    if (isIP(candidate) === 4 && BLOCK_V4.check(candidate, "ipv4")) {
      return true
    }
  }
  return false
}

function ipv4FromMapped(ipv6: string): string | null {
  const lower = ipv6.toLowerCase()
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower)
  if (dotted?.[1] !== undefined) {
    return dotted[1]
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower)
  if (hex?.[1] === undefined || hex[2] === undefined) {
    return null
  }
  const high = Number.parseInt(hex[1], 16)
  const low = Number.parseInt(hex[2], 16)
  if (!Number.isInteger(high) || !Number.isInteger(low)) {
    return null
  }
  return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`
}

function embedsEncodedPrivateIp(host: string): boolean {
  if (!WILDCARD_IP_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return false
  }
  const dashed = /(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})/g
  for (const match of host.matchAll(dashed)) {
    const octets = [match[1], match[2], match[3], match[4]]
    if (octets.some((octet) => octet === undefined)) {
      continue
    }
    const numbers = octets.map((octet) => Number(octet))
    if (numbers.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
      if (isBlockedIpv4String(numbers.join("."))) {
        return true
      }
    }
  }
  for (const token of host.split(/[.-]/)) {
    if (!/^[0-9a-f]{8}$/.test(token)) {
      continue
    }
    const value = Number.parseInt(token, 16)
    const address = `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`
    if (isBlockedIpv4String(address)) {
      return true
    }
  }
  return false
}

function embedsBlockedIpv4InIpv6(host: string): boolean {
  const parts = expandIpv6(host)
  if (parts === null) {
    return true
  }
  const [h0, h1, h2, h3, h4, h5, h6, h7] = parts
  if (
    h0 === undefined ||
    h1 === undefined ||
    h2 === undefined ||
    h3 === undefined ||
    h4 === undefined ||
    h5 === undefined ||
    h6 === undefined ||
    h7 === undefined
  ) {
    return true
  }
  // Deprecated IPv4-compatible form (::a.b.c.d). :: and ::1 are already listed.
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    return isBlockedIpv4String(ipv4FromHextets(h6, h7))
  }
  // 6to4 (2002::/16) stores the IPv4 address in bits 16–47.
  if (h0 === 0x2002) {
    return isBlockedIpv4String(ipv4FromHextets(h1, h2))
  }
  // Well-known NAT64 (64:ff9b::/96) and local NAT64 (64:ff9b:1::/48).
  if (h0 === 0x64 && h1 === 0xff9b && h3 === 0 && h4 === 0 && h5 === 0 && (h2 === 0 || h2 === 1)) {
    return isBlockedIpv4String(ipv4FromHextets(h6, h7))
  }
  // Teredo (2001:0::/32): server IPv4 is cleartext; client IPv4 is inverted.
  if (h0 === 0x2001 && h1 === 0) {
    return (
      isBlockedIpv4String(ipv4FromHextets(h2, h3)) ||
      isBlockedIpv4String(teredoClientIpv4(h6, h7))
    )
  }
  return false
}

function expandIpv6(host: string): number[] | null {
  const zone = host.indexOf("%")
  const bare = (zone === -1 ? host : host.slice(0, zone)).toLowerCase()
  const pieces = bare.split("::")
  if (pieces.length > 2) {
    return null
  }
  const left = parseIpv6Groups(pieces[0] ?? "")
  if (left === null) {
    return null
  }
  const right = pieces.length === 2 ? parseIpv6Groups(pieces[1] ?? "") : []
  if (right === null) {
    return null
  }
  if (pieces.length === 1 && left.length !== 8) {
    return null
  }
  if (pieces.length === 2 && left.length + right.length > 7) {
    return null
  }
  const missing = pieces.length === 2 ? 8 - left.length - right.length : 0
  const zeros = Array.from({ length: missing }, () => "0")
  const full = pieces.length === 2 ? [...left, ...zeros, ...right] : left
  if (full.length !== 8) {
    return null
  }
  return full.map((group) => Number.parseInt(group, 16))
}

function parseIpv6Groups(part: string): string[] | null {
  if (part.length === 0) {
    return []
  }
  const groups = part.split(":")
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return null
  }
  return groups
}

function ipv4FromHextets(high: number, low: number): string {
  return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`
}

function teredoClientIpv4(high: number, low: number): string {
  const mixed = (((high & 0xffff) * 0x10000 + (low & 0xffff)) ^ 0xffffffff) >>> 0
  return `${(mixed >>> 24) & 255}.${(mixed >>> 16) & 255}.${(mixed >>> 8) & 255}.${mixed & 255}`
}

function isBlockedIpv4String(address: string): boolean {
  return isIP(address) === 4 && BLOCK_V4.check(address, "ipv4")
}
