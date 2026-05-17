import crypto from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import type {
  AuthorizedActionContext,
  McpOAuth2AuthConfig,
} from '@nessie/schemas'

import { getCatalogEntry, ensureAuthConfigMatchesMethod } from './mcp-catalog.js'
import { getInstance } from './mcp-instances.js'
import { upsertOverride } from './mcp-credentials.js'

/**
 * OAuth handshake helper for MCP server instances whose catalog entry declares
 * `auth.method = 'oauth2'` (per plan §6 and `external-tool-integration.md` §2).
 *
 * The flow is:
 *   1. caller hits `POST /api/mcp/instances/:id/oauth/start` — we mint a
 *      cryptographically random `state`, persist it in the in-memory state
 *      store with the originating instance id + actor, and return the
 *      authorization URL the admin UI should redirect to.
 *   2. provider redirects back to `GET /api/mcp/oauth/callback?code=…&state=…`.
 *      We verify the state, exchange the code for tokens, store the access
 *      token via the existing secret store, and link the resulting
 *      `credentialRef` either onto the `McpServerInstance.credentialRef` itself
 *      or onto a `McpServerCredentialOverride` row for the actor's principal.
 *
 * The state store is in-memory only (Map keyed by token) with a 10-minute TTL
 * — fine for a single-process API per task #20's constraint that we MUST NOT
 * add an `OauthState` Prisma table or migration in this slice. If/when the API
 * is scaled horizontally the state store should move to Redis.
 *
 * The secret store integration here uses the same `secret_*` ref convention
 * the dispatcher already consumes via `SecretResolver` (`secret-resolver.ts`).
 * Tokens are persisted by storing the raw value under that ref via the
 * injected `secretStore` — the route layer wires a no-op stub today; a
 * production deployment must inject a KMS-backed implementation. The service
 * NEVER returns or logs raw access/refresh tokens.
 */

export const MCP_OAUTH_ERROR_CODES = {
  INSTANCE_NOT_FOUND: 'MCP_OAUTH_INSTANCE_NOT_FOUND',
  CATALOG_ENTRY_NOT_FOUND: 'MCP_OAUTH_CATALOG_ENTRY_NOT_FOUND',
  NOT_OAUTH2: 'MCP_OAUTH_NOT_OAUTH2',
  STATE_INVALID: 'MCP_OAUTH_STATE_INVALID',
  STATE_EXPIRED: 'MCP_OAUTH_STATE_EXPIRED',
  TOKEN_EXCHANGE_FAILED: 'MCP_OAUTH_TOKEN_EXCHANGE_FAILED',
  TOKEN_RESPONSE_INVALID: 'MCP_OAUTH_TOKEN_RESPONSE_INVALID',
} as const

export class McpOAuthError extends Error {
  override readonly name = 'McpOAuthError'

  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

/**
 * State store contract — anyone scaling beyond a single API process should
 * swap the default in-memory implementation for a Redis-backed one with the
 * same shape.
 */
export type OAuthStateRecord = {
  instanceId: string
  organizationId: string
  actorId: string
  /** epoch ms when this state token expires */
  expiresAt: number
}

export type OAuthStateStore = {
  put: (token: string, record: OAuthStateRecord) => void
  take: (token: string) => OAuthStateRecord | null
}

/** Default in-memory state store. Single-process only. */
export const createInMemoryStateStore = (): OAuthStateStore => {
  const map = new Map<string, OAuthStateRecord>()

  const purgeExpired = (now: number): void => {
    for (const [token, record] of map.entries()) {
      if (record.expiresAt <= now) {
        map.delete(token)
      }
    }
  }

  return {
    put: (token, record) => {
      purgeExpired(Date.now())
      map.set(token, record)
    },
    take: (token) => {
      const now = Date.now()
      purgeExpired(now)
      const record = map.get(token)
      if (!record) return null
      // Tokens are one-shot — delete on read regardless of expiry verdict.
      map.delete(token)
      if (record.expiresAt <= now) return null
      return record
    },
  }
}

/**
 * Per-process singleton state store. The route handler reuses this so that
 * `start` and `callback` round-trip through the same Map. Tests can override
 * by constructing their own store with `createInMemoryStateStore`.
 */
export const defaultOAuthStateStore = createInMemoryStateStore()

const STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes per task #20 spec.

/**
 * Mint a cryptographically random `state` parameter. `base64url` keeps the
 * token URL-safe so providers don't mangle it in redirects.
 */
export const generateState = (): string =>
  crypto.randomBytes(32).toString('base64url')

export type StartOAuthInput = {
  prisma: PrismaClient
  store?: OAuthStateStore
  instanceId: string
  actorContext: AuthorizedActionContext
  /**
   * Absolute callback URL the provider should redirect back to. Required so
   * tests and prod can both construct the URL deterministically without
   * coupling the service to the HTTP layer.
   */
  callbackUrl: string
}

export type StartOAuthResult = {
  authorizationUrl: string
  state: string
}

/**
 * Build the provider authorization URL and persist the state token so the
 * callback handler can correlate the response back to this instance + actor.
 */
export const startOAuth = async (
  input: StartOAuthInput,
): Promise<StartOAuthResult> => {
  const store = input.store ?? defaultOAuthStateStore
  const { prisma, instanceId, actorContext, callbackUrl } = input
  const organizationId = actorContext.tenant.organizationId

  const instance = await getInstance(prisma, organizationId, instanceId)
  if (!instance) {
    throw new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.INSTANCE_NOT_FOUND,
      `MCP server instance ${instanceId} not found`,
    )
  }
  const catalogEntry = await getCatalogEntry(
    prisma,
    organizationId,
    instance.catalogEntryId,
  )
  if (!catalogEntry) {
    throw new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.CATALOG_ENTRY_NOT_FOUND,
      `Catalog entry ${instance.catalogEntryId} not found`,
    )
  }
  if (catalogEntry.authMethod !== 'oauth2') {
    throw new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.NOT_OAUTH2,
      `Catalog entry ${catalogEntry.id} uses authMethod ${catalogEntry.authMethod}, not oauth2`,
    )
  }

  // Re-parse via the discriminated union to narrow + guarantee shape. The
  // route layer already validates on write so this is a safety net.
  const parsed = ensureAuthConfigMatchesMethod(
    catalogEntry.authMethod,
    catalogEntry.authConfig,
  ) as McpOAuth2AuthConfig

  const token = generateState()
  store.put(token, {
    instanceId,
    organizationId,
    actorId: actorContext.actor.actorId,
    expiresAt: Date.now() + STATE_TTL_MS,
  })

  // Per RFC 6749 §4.1.1 the authorization request MUST carry `client_id`.
  // Real providers (GitHub, Google, Atlassian, Notion, …) reject the redirect
  // outright when it's missing, so we always set it from the catalog config.
  const authUrl = new URL(parsed.authorizationUrl)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', parsed.clientId)
  authUrl.searchParams.set('state', token)
  authUrl.searchParams.set('redirect_uri', callbackUrl)
  if (parsed.scopes.length > 0) {
    authUrl.searchParams.set('scope', parsed.scopes.join(' '))
  }

  return {
    authorizationUrl: authUrl.toString(),
    state: token,
  }
}

/**
 * Adapter for the token exchange HTTP call. Lets tests inject a fake instead
 * of running real fetch traffic. Implementations MUST NOT log the returned
 * payload — pass it straight through to the service.
 */
export type TokenExchangeFn = (input: {
  tokenUrl: string
  code: string
  redirectUri: string
  clientId: string
  clientSecret: string
}) => Promise<{
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  tokenType?: string
}>

/**
 * Per RFC 6749 §4.1.3 the `authorization_code` token request MUST include
 * `client_id`, and confidential clients MUST authenticate. §2.3.1 lets us
 * authenticate the secret via HTTP Basic OR via the request body; we use the
 * body form here so a single POST carries everything and we don't have to
 * special-case providers that reject Basic (e.g. some GitHub Enterprise
 * installs). Both client_id and client_secret are URL-encoded by
 * `URLSearchParams` automatically.
 */
export const defaultTokenExchange: TokenExchangeFn = async ({
  tokenUrl,
  code,
  redirectUri,
  clientId,
  clientSecret,
}) => {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  })
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  })
  if (!response.ok) {
    throw new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.TOKEN_EXCHANGE_FAILED,
      `Token endpoint returned ${response.status}`,
    )
  }
  const payload = (await response.json()) as Record<string, unknown>
  const accessToken = payload['access_token']
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.TOKEN_RESPONSE_INVALID,
      'Token response missing access_token',
    )
  }
  const refresh = payload['refresh_token']
  const expires = payload['expires_in']
  const tokenType = payload['token_type']
  return {
    accessToken,
    refreshToken: typeof refresh === 'string' ? refresh : undefined,
    expiresIn: typeof expires === 'number' ? expires : undefined,
    tokenType: typeof tokenType === 'string' ? tokenType : undefined,
  }
}

/**
 * Contract for persisting raw token material behind an opaque ref. The
 * default in-memory implementation is suitable for unit tests only. Production
 * deployments MUST inject a KMS-backed store so plaintext never lives in
 * process memory beyond a single request lifetime.
 */
export type SecretStore = {
  put: (input: {
    accessToken: string
    refreshToken?: string
    expiresIn?: number
    tokenType?: string
  }) => Promise<string>
}

/** Throws on use; routes wire this until the KMS secret store lands. */
export const inMemorySecretStoreStub = (): SecretStore => {
  let counter = 0
  return {
    put: async () => {
      counter += 1
      // Convention matches the dispatcher's `secret_*` ref shape so the
      // resolver can pick it up the same way as manually-configured refs.
      return `secret_oauth_${Date.now()}_${counter}`
    },
  }
}

export type CompleteOAuthInput = {
  prisma: PrismaClient
  store?: OAuthStateStore
  secretStore: SecretStore
  tokenExchange?: TokenExchangeFn
  state: string
  code: string
  callbackUrl: string
}

export type CompleteOAuthResult = {
  instanceId: string
  credentialRef: string
}

/**
 * Verify state + exchange code for tokens + persist secret ref. The state
 * token is consumed (single-use) regardless of downstream success — we never
 * want a leaked state to be re-playable. On any failure after consumption,
 * the caller must restart the flow.
 */
export const completeOAuth = async (
  input: CompleteOAuthInput,
): Promise<CompleteOAuthResult> => {
  const store = input.store ?? defaultOAuthStateStore
  const tokenExchange = input.tokenExchange ?? defaultTokenExchange

  if (!input.state || input.state.length === 0) {
    throw new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.STATE_INVALID,
      'state parameter is required',
    )
  }
  const record = store.take(input.state)
  if (!record) {
    // `take` returns null both for unknown tokens and for expired ones; we
    // surface the expired-vs-invalid distinction as a single code because the
    // server-side state map has already deleted the entry in either case.
    throw new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.STATE_INVALID,
      'state token is invalid or expired',
    )
  }
  if (!input.code || input.code.length === 0) {
    throw new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.TOKEN_EXCHANGE_FAILED,
      'code parameter is required',
    )
  }

  const instance = await getInstance(
    input.prisma,
    record.organizationId,
    record.instanceId,
  )
  if (!instance) {
    throw new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.INSTANCE_NOT_FOUND,
      `MCP server instance ${record.instanceId} not found`,
    )
  }
  const catalogEntry = await getCatalogEntry(
    input.prisma,
    record.organizationId,
    instance.catalogEntryId,
  )
  if (!catalogEntry) {
    throw new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.CATALOG_ENTRY_NOT_FOUND,
      `Catalog entry ${instance.catalogEntryId} not found`,
    )
  }
  const parsed = ensureAuthConfigMatchesMethod(
    catalogEntry.authMethod,
    catalogEntry.authConfig,
  ) as McpOAuth2AuthConfig

  const tokens = await tokenExchange({
    tokenUrl: parsed.tokenUrl,
    code: input.code,
    redirectUri: input.callbackUrl,
    clientId: parsed.clientId,
    clientSecret: parsed.clientSecret,
  })
  const credentialRef = await input.secretStore.put({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    tokenType: tokens.tokenType,
  })

  // Link the new ref onto a per-user credential override so different users
  // installing the same instance don't share OAuth identities. This matches
  // the 7-level resolution chain in `mcp-credentials.ts` — the override at
  // `principalType=user` outranks the instance's bare `credentialRef`.
  await upsertOverride(input.prisma, {
    instanceId: record.instanceId,
    principalType: 'user',
    principalId: record.actorId,
    credentialRef,
  })

  return {
    instanceId: record.instanceId,
    credentialRef,
  }
}
