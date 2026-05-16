import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { HttpFetchError } from './http-fetch-error.js'

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'host.docker.internal',
  'gateway.docker.internal',
  'metadata.google.internal',
])

const isBlockedIpv4Address = (value: string): boolean => {
  const parts = value.split('.').map((part) => Number.parseInt(part, 10))
  if (
    parts.length !== 4 ||
    parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)
  ) {
    return true
  }
  const first = parts[0]
  const second = parts[1]
  if (first === undefined || second === undefined) {
    return true
  }
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19))
  )
}

const isBlockedIpv6Address = (value: string): boolean => {
  const normalized = value.toLowerCase()
  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  )
}

const isBlockedIpAddress = (value: string): boolean => {
  const version = isIP(value)
  if (version === 4) return isBlockedIpv4Address(value)
  if (version === 6) return isBlockedIpv6Address(value)
  return true
}

/**
 * Validate a URL for outbound fetch from a tool: http(s) only, no credentials,
 * no blocked hostnames, no private/link-local IPs (including DNS-resolved).
 * Throws {@link HttpFetchError} on rejection. Defense-in-depth for both the
 * initial URL and any redirect target.
 *
 * Canonical SSRF guard for the worker; the legacy web_fetch dispatch in
 * `worker/src/run/tools.ts` also routes through this function.
 */
export const assertSafeUrl = async (rawUrl: string | URL): Promise<URL> => {
  const url = typeof rawUrl === 'string' ? new URL(rawUrl) : rawUrl

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpFetchError(`Unsupported URL scheme: ${url.protocol}`)
  }
  if (url.username || url.password) {
    throw new HttpFetchError('Authenticated URLs are not allowed.')
  }

  const hostname = url.hostname.toLowerCase()
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    throw new HttpFetchError('Private or local network URLs are not allowed.')
  }

  if (isIP(hostname) !== 0) {
    if (isBlockedIpAddress(hostname)) {
      throw new HttpFetchError('Private or local network URLs are not allowed.')
    }
    return url
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true })
  if (
    addresses.length === 0 ||
    addresses.some((entry) => isBlockedIpAddress(entry.address))
  ) {
    throw new HttpFetchError('Private or local network URLs are not allowed.')
  }
  return url
}
