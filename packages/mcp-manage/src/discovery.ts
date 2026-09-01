import { assertSafeUrl, UrlSafetyError } from '@nessie/runtime'

import { probeConnection, type ManagerFactory } from './mcp-instance-probe.js'
import { pinnedMcpFetch } from './mcp-security.js'
import { discoverOAuthServerConfig } from './oauth-discovery.js'
import type { McpLibraryAuthMethod, McpLibraryTransport } from './library.js'

/**
 * MCP endpoint discovery: turn "I have a link" into an installable connector
 * proposal (plan: admin "Add from link" + personal-assistant
 * `connector_discover` tool).
 *
 * Given a bare URL (or one copied from a vendor's docs), we try the URL itself
 * plus the well-known endpoint suffixes (`/mcp`, `/sse`, `/mcp/sse`) over both
 * MCP remote transports (streamable HTTP first, then legacy SSE). Every
 * candidate URL passes the shared SSRF guard before any traffic is sent.
 *
 * Outcomes per candidate:
 * - a successful `tools/list` handshake → installable with `authMethod: none`;
 * - an HTTP 401/403 from the endpoint → a real server that wants credentials.
 *   When the server publishes OAuth metadata (RFC 9728/8414) the proposal is
 *   `authMethod: oauth2` — sign-in based, no key to paste; otherwise
 *   `authMethod: bearer` with guidance to obtain an API key;
 * - anything else → not an MCP endpoint at that URL.
 */

export type McpDiscoveryAttempt = {
  url: string
  transport: McpLibraryTransport
  outcome: 'ok' | 'auth_required' | 'unreachable' | 'not_mcp' | 'blocked'
  detail: string | null
  toolCount?: number
}

export type McpDiscoveryProposal = {
  url: string
  transport: McpLibraryTransport
  authMethod: McpLibraryAuthMethod
  /** Tool names seen during the unauthenticated handshake, when it succeeded. */
  toolNames: string[]
  /** Human guidance for finishing setup (e.g. what credential to provide). */
  note: string | null
}

export type McpDiscoveryResult = {
  input: string
  ok: boolean
  proposal: McpDiscoveryProposal | null
  attempts: McpDiscoveryAttempt[]
}

export type DiscoverOptions = {
  fetchImpl?: typeof fetch
  managerFactory?: ManagerFactory
  /** Per-candidate probe budget. Discovery tries up to 8 transport probes. */
  probeTimeoutMs?: number
}

const DEFAULT_PROBE_TIMEOUT_MS = 8_000
const WELL_KNOWN_SUFFIXES = ['/mcp', '/sse', '/mcp/sse']

const normalizeInputUrl = (raw: string): string => {
  const trimmed = raw.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

/** The URL as given, then well-known suffixes appended to its origin+path. */
export const candidateUrlsFor = (rawUrl: string): string[] => {
  const base = normalizeInputUrl(rawUrl)
  let parsed: URL
  try {
    parsed = new URL(base)
  } catch {
    return [base]
  }
  const withoutSlash = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
  const candidates = [base]
  for (const suffix of WELL_KNOWN_SUFFIXES) {
    if (withoutSlash.endsWith(suffix)) continue
    const candidate = `${withoutSlash}${suffix}`
    if (!candidates.includes(candidate)) candidates.push(candidate)
  }
  return candidates
}

const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type AuthSignal = { status: number; wwwAuthenticate: string | null } | null

/**
 * Ask the endpoint directly whether it wants credentials. Uses a plain GET
 * with redirects disabled (a redirect could point inside the network, so we
 * never follow one). Any network failure is treated as "no signal".
 */
const fetchAuthSignal = async (
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<AuthSignal> => {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json, text/event-stream' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    // Drain nothing: status + headers are all we need.
    await response.body?.cancel().catch(() => undefined)
    return {
      status: response.status,
      wwwAuthenticate: response.headers.get('www-authenticate'),
    }
  } catch {
    return null
  }
}

const BEARER_NOTE =
  'This server requires a credential. Ask the vendor for an API key or '
  + 'personal access token and add it as the connector secret.'
const OAUTH_NOTE =
  'This server supports OAuth sign-in — connect it and approve access with '
  + 'your existing account; no key to paste.'

export const discoverMcpEndpoint = async (
  rawUrl: string,
  options: DiscoverOptions = {},
): Promise<McpDiscoveryResult> => {
  const fetchImpl = options.fetchImpl ?? pinnedMcpFetch
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const attempts: McpDiscoveryAttempt[] = []
  const input = normalizeInputUrl(rawUrl)

  let authProposal: McpDiscoveryProposal | null = null

  for (const url of candidateUrlsFor(rawUrl)) {
    try {
      await assertSafeUrl(url)
    } catch (error) {
      attempts.push({
        url,
        transport: 'http',
        outcome: 'blocked',
        detail: error instanceof UrlSafetyError ? error.message : String(error),
      })
      continue
    }

    // Streamable HTTP first (current spec), legacy SSE second. SSE endpoints
    // ending in /sse virtually never speak streamable HTTP, so skip it there.
    const transports: McpLibraryTransport[] = url.endsWith('/sse') ? ['sse'] : ['http', 'sse']
    for (const transport of transports) {
      const probe = await withTimeout(
        probeConnection({ transport, url }, options.managerFactory),
        probeTimeoutMs,
        `MCP probe (${transport})`,
      ).catch((error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: probeTimeoutMs,
      }))

      if (probe.ok) {
        const descriptors = 'descriptors' in probe ? probe.descriptors ?? [] : []
        attempts.push({
          url,
          transport,
          outcome: 'ok',
          detail: null,
          toolCount: descriptors.length,
        })
        return {
          input,
          ok: true,
          proposal: {
            url,
            transport,
            authMethod: 'none',
            toolNames: descriptors.map((d) => d.name),
            note: null,
          },
          attempts,
        }
      }

      const detail = 'error' in probe ? probe.error ?? null : null
      const looksAuthFailure = detail !== null && (
        /\b(?:401|403)\b/.test(detail)
        || /(?:^|[^A-Za-z0-9])(?:unauthorized|forbidden)(?:$|[^A-Za-z0-9])/i.test(detail)
      )
      attempts.push({
        url,
        transport,
        outcome: looksAuthFailure ? 'auth_required' : 'not_mcp',
        detail,
      })
      if (looksAuthFailure && !authProposal) {
        // Prefer OAuth when the server publishes discovery metadata — the
        // user just signs in, no key to obtain. Fall back to bearer guidance.
        const oauth = await discoverOAuthServerConfig(url, {
          fetchImpl,
          timeoutMs: probeTimeoutMs,
        }).catch(() => null)
        if (oauth && oauth.metadataSource === 'metadata') {
          authProposal = {
            url,
            transport,
            authMethod: 'oauth2',
            toolNames: [],
            note: OAUTH_NOTE,
          }
        } else {
          const signal = await fetchAuthSignal(url, fetchImpl, probeTimeoutMs)
          authProposal = {
            url,
            transport,
            authMethod: 'bearer',
            toolNames: [],
            note: /oauth/i.test(signal?.wwwAuthenticate ?? '')
              ? `${BEARER_NOTE} (The server hints at OAuth support but publishes no usable metadata.)`
              : BEARER_NOTE,
          }
        }
      }
    }
  }

  return {
    input,
    ok: authProposal !== null,
    proposal: authProposal,
    attempts,
  }
}
