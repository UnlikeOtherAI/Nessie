import crypto from 'node:crypto'

import { z } from 'zod'

import {
  assertMcpUrlSafe,
  pinnedMcpFetch,
  type McpUrlSafetyOptions,
} from './mcp-security.js'

/**
 * MCP-spec OAuth discovery (authorization spec 2025-06-18):
 *
 * 1. An unauthenticated request to the MCP server returns 401 with
 *    `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728).
 * 2. The protected-resource metadata names its `authorization_servers`.
 * 3. The authorization server's metadata (RFC 8414, with OIDC discovery as a
 *    fallback) yields the authorize/token/registration endpoints.
 * 4. When a `registration_endpoint` exists, a client can be minted on the fly
 *    via Dynamic Client Registration (RFC 7591) — no vendor console needed.
 *
 * Every URL is SSRF-checked before any traffic is sent and redirects are
 * never followed. Older servers without RFC 9728 metadata fall back to
 * RFC 8414 metadata on the MCP server's own origin, then to the spec's
 * default `/authorize` + `/token` + `/register` paths (2025-03-26 back-compat).
 */

export type OAuthServerConfig = {
  /** Canonical MCP server URL — the RFC 8707 `resource` indicator. */
  resource: string
  /** Authorization server base the config came from. */
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string | null
  scopesSupported: string[]
  supportsS256: boolean
  /**
   * `metadata` when the server genuinely publishes RFC 9728/8414 documents;
   * `fallback` when only the spec's legacy default endpoints were assumed.
   * Discovery proposals treat `fallback` as bearer-only — assuming OAuth for
   * every 401 would steer users of API-key servers into a dead end.
   */
  metadataSource: 'metadata' | 'fallback'
}

export type OAuthDiscoveryOptions = {
  fetchImpl?: typeof fetch
  resolveHost?: McpUrlSafetyOptions['resolveHost']
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 8_000

const ProtectedResourceMetadataSchema = z.object({
  resource: z.string().optional(),
  authorization_servers: z.array(z.string()).optional(),
  scopes_supported: z.array(z.string()).optional(),
})

const AuthServerMetadataSchema = z.object({
  issuer: z.string().optional(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  scopes_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
})

const safeFetchJson = async (
  url: string,
  options: OAuthDiscoveryOptions,
  init?: RequestInit,
): Promise<unknown | null> => {
  try {
    await assertMcpUrlSafe(url, { resolveHost: options.resolveHost })
  } catch {
    return null
  }
  const fetchImpl = options.fetchImpl ?? pinnedMcpFetch
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    return (await response.json()) as unknown
  } catch {
    return null
  }
}

/** Pull the RFC 9728 resource_metadata URL out of a WWW-Authenticate header. */
export const parseResourceMetadataUrl = (header: string | null): string | null => {
  if (!header) return null
  const match = /resource_metadata="([^"]+)"/i.exec(header)
  return match?.[1] ?? null
}

/**
 * Ask the MCP server itself for its auth challenge. A spec-compliant server
 * answers an unauthenticated POST with 401 + WWW-Authenticate.
 */
const fetchChallengeHeader = async (
  serverUrl: string,
  options: OAuthDiscoveryOptions,
): Promise<string | null> => {
  try {
    await assertMcpUrlSafe(serverUrl, { resolveHost: options.resolveHost })
  } catch {
    return null
  }
  const fetchImpl = options.fetchImpl ?? pinnedMcpFetch
  try {
    const response = await fetchImpl(serverUrl, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize' }),
    })
    await response.body?.cancel().catch(() => undefined)
    return response.headers.get('www-authenticate')
  } catch {
    return null
  }
}

/** RFC 8414 §3.1 well-known candidates for an issuer URL (path-aware). */
const authServerMetadataCandidates = (issuer: string): string[] => {
  const url = new URL(issuer)
  const path = url.pathname.replace(/\/+$/, '')
  const candidates: string[] = []
  if (path && path !== '') {
    candidates.push(`${url.origin}/.well-known/oauth-authorization-server${path}`)
    candidates.push(`${url.origin}${path}/.well-known/oauth-authorization-server`)
  } else {
    candidates.push(`${url.origin}/.well-known/oauth-authorization-server`)
  }
  if (path && path !== '') {
    candidates.push(`${url.origin}${path}/.well-known/openid-configuration`)
    candidates.push(`${url.origin}/.well-known/openid-configuration${path}`)
  } else {
    candidates.push(`${url.origin}/.well-known/openid-configuration`)
  }
  return candidates
}

const loadAuthServerMetadata = async (
  issuer: string,
  options: OAuthDiscoveryOptions,
): Promise<z.infer<typeof AuthServerMetadataSchema> | null> => {
  for (const candidate of authServerMetadataCandidates(issuer)) {
    const payload = await safeFetchJson(candidate, options)
    if (!payload) continue
    const parsed = AuthServerMetadataSchema.safeParse(payload)
    if (parsed.success) return parsed.data
  }
  return null
}

const canonicalResource = (serverUrl: string): string => {
  const url = new URL(serverUrl)
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/$/, '')
}

/**
 * Discover the OAuth configuration protecting an MCP server URL. Returns null
 * when the server publishes no usable metadata (in which case a bearer token
 * is the only option).
 */
export const discoverOAuthServerConfig = async (
  serverUrl: string,
  options: OAuthDiscoveryOptions = {},
): Promise<OAuthServerConfig | null> => {
  const server = new URL(serverUrl)
  const serverPath = server.pathname.replace(/\/+$/, '')

  // 1. Preferred: the server names its own resource metadata in the 401.
  const challenge = await fetchChallengeHeader(serverUrl, options)
  const advertised = parseResourceMetadataUrl(challenge)

  // 2. Fall back to the RFC 9728 well-known locations (path-aware, then root).
  const prmCandidates = [
    ...(advertised ? [advertised] : []),
    ...(serverPath
      ? [`${server.origin}/.well-known/oauth-protected-resource${serverPath}`]
      : []),
    `${server.origin}/.well-known/oauth-protected-resource`,
  ]

  let resource = canonicalResource(serverUrl)
  let issuers: string[] = []
  let prmScopes: string[] = []
  for (const candidate of prmCandidates) {
    const payload = await safeFetchJson(candidate, options)
    if (!payload) continue
    const parsed = ProtectedResourceMetadataSchema.safeParse(payload)
    if (!parsed.success) continue
    if (parsed.data.authorization_servers?.length) {
      issuers = parsed.data.authorization_servers
      if (parsed.data.resource) resource = parsed.data.resource
      prmScopes = parsed.data.scopes_supported ?? []
      break
    }
  }

  // 3. No PRM → 2025-03-26 back-compat: the MCP server origin doubles as the
  //    authorization server.
  if (issuers.length === 0) {
    issuers = [server.origin]
  }

  for (const issuer of issuers) {
    try {
      await assertMcpUrlSafe(issuer, { resolveHost: options.resolveHost })
    } catch {
      continue
    }
    const metadata = await loadAuthServerMetadata(issuer, options)
    if (metadata) {
      return {
        resource,
        issuer,
        authorizationEndpoint: metadata.authorization_endpoint,
        tokenEndpoint: metadata.token_endpoint,
        registrationEndpoint: metadata.registration_endpoint ?? null,
        scopesSupported: metadata.scopes_supported?.length
          ? metadata.scopes_supported
          : prmScopes,
        supportsS256:
          metadata.code_challenge_methods_supported?.includes('S256')
          ?? true,
        metadataSource: 'metadata',
      }
    }
  }

  // 4. Last resort: spec-default endpoints on the server origin — but only
  //    when the server actually challenged for auth (otherwise we'd invent an
  //    OAuth config for servers that simply have none).
  if (challenge && /bearer/i.test(challenge)) {
    return {
      resource,
      issuer: server.origin,
      authorizationEndpoint: `${server.origin}/authorize`,
      tokenEndpoint: `${server.origin}/token`,
      registrationEndpoint: `${server.origin}/register`,
      scopesSupported: prmScopes,
      supportsS256: true,
      metadataSource: 'fallback',
    }
  }
  return null
}

// ─── Dynamic Client Registration (RFC 7591) ─────────────────────────────────

export type DynamicClientRegistration = {
  clientId: string
  clientSecret: string | null
  raw: Record<string, unknown>
}

export class OAuthDiscoveryError extends Error {
  override readonly name = 'OAuthDiscoveryError'
}

export const registerDynamicClient = async (
  input: {
    registrationEndpoint: string
    redirectUris: string[]
    clientName: string
  },
  options: OAuthDiscoveryOptions = {},
): Promise<DynamicClientRegistration> => {
  await assertMcpUrlSafe(input.registrationEndpoint, {
    resolveHost: options.resolveHost,
  })
  const fetchImpl = options.fetchImpl ?? pinnedMcpFetch
  const response = await fetchImpl(input.registrationEndpoint, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: input.clientName,
      redirect_uris: input.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Public client: PKCE carries the proof, no secret to manage/leak.
      token_endpoint_auth_method: 'none',
    }),
  })
  if (response.status !== 200 && response.status !== 201) {
    await response.body?.cancel().catch(() => undefined)
    throw new OAuthDiscoveryError(
      `Dynamic client registration failed: HTTP ${response.status}`,
    )
  }
  const payload = (await response.json()) as Record<string, unknown>
  const clientId = payload['client_id']
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new OAuthDiscoveryError('Registration response missing client_id')
  }
  const secret = payload['client_secret']
  // Strip any echoed secrets before persisting the raw metadata.
  const rest = { ...payload }
  delete rest['client_secret']
  delete rest['registration_access_token']
  return {
    clientId,
    clientSecret: typeof secret === 'string' && secret.length > 0 ? secret : null,
    raw: rest,
  }
}

// ─── PKCE (RFC 7636) ────────────────────────────────────────────────────────

export type PkcePair = { verifier: string; challenge: string }

export const generatePkcePair = (): PkcePair => {
  const verifier = crypto.randomBytes(48).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}
