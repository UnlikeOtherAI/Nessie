/**
 * The one place a dashboard reaches the network
 * (2026-08-13-live-data-dashboards plan §4.1, §11.3).
 *
 * API preview, on-demand refresh, scheduled refresh in the worker, conditional
 * revalidation and retry all call `fetchDashboardSource`. No other path may
 * fetch a source, and none accepts a pre-fetched body — a caller handing in
 * bytes would bypass every control below.
 *
 * What this closes, and why each control is here rather than assumed:
 *
 * - **SSRF**: `safeFetch` resolves once and pins the socket to the vetted
 *   addresses, so the DNS-rebinding window between validating a URL and
 *   dialing it never opens. `assertSafeUrl` + `fetch` is specifically NOT
 *   equivalent and is banned by AGENTS.md.
 * - **Credential leakage on redirect**: `maxRedirects: 0` whenever a credential
 *   is attached. Redirect *revalidation* is not enough — even a legitimate
 *   public redirect must not receive an origin-bound secret.
 * - **Decompression bombs**: `Accept-Encoding: identity` and any encoded
 *   response is rejected outright, which is stronger and simpler than trying to
 *   account for a compression ratio.
 * - **Oversized responses**: a declared `Content-Length` over the cap is
 *   refused before a byte is read, and the stream is counted as it arrives
 *   because a `Content-Length` can lie or be absent.
 * - **Loopback to Nessie itself**: the deployment's own API/admin origins are
 *   denied even when publicly routable, so a dashboard cannot become a
 *   confused deputy against Nessie's own REST surface.
 *
 * Nothing here ever puts a response body, a URL query, or a credential into an
 * error, a log line, or a returned value: callers get a stable code.
 */

import { safeFetch } from '@nessie/runtime'

export const DASHBOARD_FETCH_TIMEOUT_MS = 10_000
export const DASHBOARD_MAX_RESPONSE_BYTES = 1024 * 1024
export const DASHBOARD_MAX_JSON_DEPTH = 20

/**
 * Stable, caller-safe failure codes. A viewer sees only "stale" or
 * "unavailable"; a source manager sees one of these. An upstream message never
 * reaches either, because it is attacker-influenced text.
 */
export type DashboardFetchErrorCode =
  | 'SOURCE_URL_REJECTED'
  | 'SOURCE_TIMEOUT'
  | 'SOURCE_UNREACHABLE'
  | 'SOURCE_AUTH_REJECTED'
  | 'SOURCE_HTTP_ERROR'
  | 'SOURCE_REDIRECTED'
  | 'SOURCE_RESPONSE_TOO_LARGE'
  | 'SOURCE_RESPONSE_ENCODED'
  | 'SOURCE_NOT_JSON'
  | 'SOURCE_INVALID_JSON'

export class DashboardFetchError extends Error {
  constructor(
    readonly code: DashboardFetchErrorCode,
    /** Operator-facing only. Never contains a body, a URL query, or a secret. */
    readonly detail?: string,
  ) {
    super(code)
    this.name = 'DashboardFetchError'
  }
}

export type DashboardSourceRequest = {
  origin: string
  path: string
  queryParams?: Record<string, string | number | boolean> | null
  /** Resolved server-side from the encrypted store. Never logged or returned. */
  credential?: { mode: 'bearer' | 'header'; headerName?: string; value: string } | null
  /** Conditional GET state from the previous successful fetch. */
  etag?: string | null
  lastModified?: string | null
}

export type DashboardFetchOutcome =
  | { status: 'not_modified' }
  | { status: 'ok'; document: unknown; etag: string | null; lastModified: string | null }

/**
 * Header names a source may never set. Identity, forwarding, and hop-by-hop
 * headers are excluded because a source that could set them would be able to
 * impersonate a caller or confuse an intermediary.
 */
const FORBIDDEN_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-forwarded-for',
  // These are outbound denylist values, not reads from inbound request headers.
  // eslint-disable-next-line no-restricted-syntax
  'x-forwarded-host',
  // eslint-disable-next-line no-restricted-syntax
  'x-forwarded-proto',
  'x-real-ip',
  'x-nessie-context',
  'x-uoa-delegation',
])

export type DashboardEgressPolicy = {
  /** Origins belonging to this deployment. Denied even when publicly routable. */
  deniedOrigins: string[]
}

const normalizeOrigin = (value: string): string | null => {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}`.toLowerCase()
  } catch {
    return null
  }
}

/**
 * HTTPS only, no credentials in the URL, no fragment, and never one of the
 * deployment's own origins. Runs at write time as well as fetch time: a source
 * saved before a policy change must not keep working.
 */
export const buildSourceUrl = (
  request: DashboardSourceRequest,
  policy: DashboardEgressPolicy,
): URL => {
  let url: URL
  try {
    url = new URL(request.path || '/', request.origin)
  } catch {
    throw new DashboardFetchError('SOURCE_URL_REJECTED', 'origin or path is not a valid URL')
  }

  if (url.protocol !== 'https:') {
    throw new DashboardFetchError('SOURCE_URL_REJECTED', 'only https is allowed')
  }
  if (url.username || url.password) {
    throw new DashboardFetchError('SOURCE_URL_REJECTED', 'credentials in the URL are not allowed')
  }

  const origin = normalizeOrigin(url.toString())
  const denied = policy.deniedOrigins
    .map(normalizeOrigin)
    .filter((value): value is string => value !== null)
  if (origin && denied.includes(origin)) {
    throw new DashboardFetchError(
      'SOURCE_URL_REJECTED',
      'this deployment\'s own origin cannot be a dashboard source',
    )
  }

  url.hash = ''
  for (const [key, value] of Object.entries(request.queryParams ?? {})) {
    url.searchParams.set(key, String(value))
  }
  return url
}

const buildHeaders = (request: DashboardSourceRequest): Headers => {
  const headers = new Headers({
    accept: 'application/json',
    // Reject rather than decompress: a compression bomb is not worth the
    // bandwidth saving on a capped 1 MiB response.
    'accept-encoding': 'identity',
    'user-agent': 'Nessie-Dashboards/1.0',
  })

  const credential = request.credential
  if (credential) {
    if (credential.mode === 'bearer') {
      headers.set('authorization', `Bearer ${credential.value}`)
    } else {
      const name = (credential.headerName ?? '').trim().toLowerCase()
      if (!name || FORBIDDEN_HEADER_NAMES.has(name) || !/^[a-z0-9-]+$/.test(name)) {
        throw new DashboardFetchError('SOURCE_URL_REJECTED', 'credential header name is not allowed')
      }
      headers.set(name, credential.value)
    }
  }

  if (request.etag) headers.set('if-none-match', request.etag)
  if (request.lastModified) headers.set('if-modified-since', request.lastModified)
  return headers
}

/** Counts bytes as they arrive: a Content-Length may be absent or dishonest. */
const readCappedText = async (response: Response): Promise<string> => {
  const declared = response.headers.get('content-length')
  if (declared && Number(declared) > DASHBOARD_MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new DashboardFetchError('SOURCE_RESPONSE_TOO_LARGE')
  }

  const body = response.body
  if (!body) return ''

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > DASHBOARD_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new DashboardFetchError('SOURCE_RESPONSE_TOO_LARGE')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock?.()
  }

  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8').decode(joined)
}

/**
 * Depth guard applied after parsing. `JSON.parse` itself is not the risk — an
 * absurdly nested document is, because JMESPath and the normalizer would walk
 * it. Cheap to check, and it fails with a stable code instead of a stack
 * overflow somewhere less legible.
 */
const assertDepth = (value: unknown, depth = 0): void => {
  if (depth > DASHBOARD_MAX_JSON_DEPTH) {
    throw new DashboardFetchError('SOURCE_INVALID_JSON', 'document nests too deeply')
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertDepth(entry, depth + 1)
    return
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) assertDepth(entry, depth + 1)
  }
}

export const fetchDashboardSource = async (
  request: DashboardSourceRequest,
  policy: DashboardEgressPolicy,
  deps: { fetchImpl?: typeof safeFetch } = {},
): Promise<DashboardFetchOutcome> => {
  const url = buildSourceUrl(request, policy)
  const headers = buildHeaders(request)
  const run = deps.fetchImpl ?? safeFetch

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DASHBOARD_FETCH_TIMEOUT_MS)

  let response: Response
  try {
    response = await run(
      url,
      { method: 'GET', headers, signal: controller.signal, redirect: 'manual' },
      // Zero redirects whenever a secret rides along; still zero without one,
      // so a source has exactly one predictable contract and the editor is
      // forced to save the final endpoint.
      { maxRedirects: 0 },
    )
  } catch (error) {
    if (controller.signal.aborted) throw new DashboardFetchError('SOURCE_TIMEOUT')
    const name = error instanceof Error ? error.name : ''
    if (name === 'UrlSafetyError') {
      throw new DashboardFetchError('SOURCE_URL_REJECTED', 'blocked by the egress guard')
    }
    throw new DashboardFetchError('SOURCE_UNREACHABLE')
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 304) {
    await response.body?.cancel().catch(() => undefined)
    return { status: 'not_modified' }
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined)
    throw new DashboardFetchError('SOURCE_REDIRECTED', 'the endpoint redirected; save the final URL')
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined)
    throw new DashboardFetchError('SOURCE_AUTH_REJECTED')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new DashboardFetchError('SOURCE_HTTP_ERROR', `status ${response.status}`)
  }

  const encoding = response.headers.get('content-encoding')
  if (encoding && encoding.toLowerCase() !== 'identity') {
    await response.body?.cancel().catch(() => undefined)
    throw new DashboardFetchError('SOURCE_RESPONSE_ENCODED')
  }

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
  const isJson = contentType === 'application/json' || /^application\/[\w.+-]+\+json$/.test(contentType ?? '')
  if (!isJson) {
    await response.body?.cancel().catch(() => undefined)
    throw new DashboardFetchError('SOURCE_NOT_JSON', `content-type ${contentType || 'absent'}`)
  }

  const text = await readCappedText(response)
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    // Deliberately no parser message: it can quote the body back.
    throw new DashboardFetchError('SOURCE_INVALID_JSON')
  }
  assertDepth(document)

  return {
    status: 'ok',
    document,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
  }
}
