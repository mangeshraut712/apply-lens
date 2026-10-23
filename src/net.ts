/**
 * URL policy for the cloud browser.
 *
 * The browser runs off-box, so a posting or a link it contains must not be
 * able to aim the session at loopback, link-local, or metadata addresses.
 */
import { BlockList, isIP } from "node:net"

const MAX_NAVIGATION_URL_LENGTH = 2048
const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
])
const BLOCKED_SUFFIXES = [
  ".local",
  ".localhost",
  ".localdomain",
  ".internal",
  ".home.arpa",
  ".lan",
]
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

export function oneLine(message: string, secret?: string, limit = 500): string {
  const flat = redactSecrets(message, secret).replace(/[\r\n\u2028\u2029]+/g, " ")
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
  if (isBlockedIp(host) || embedsBlockedIpv4(host)) {
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
    return BLOCK_V6.check(host, "ipv6")
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
