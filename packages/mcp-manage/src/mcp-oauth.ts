import crypto from 'node:crypto'

import type { Prisma, PrismaClient } from '@prisma/client'
import type {
  AuthorizedActionContext,
  McpOAuth2AuthConfig,
} from '@nessie/schemas'

import { getCatalogEntry, ensureAuthConfigMatchesMethod } from './mcp-catalog.js'
import { getInstance, resolveMcpUserAccess } from './mcp-instances.js'
import { resolveInstanceTransport } from './mcp-instance-probe.js'
import {
  McpSecurityError,
  assertMcpAuthUrlsSafe,
  assertMcpUrlSafe,
  type McpUrlSafetyOptions,
} from './mcp-security.js'
import {
  discoverOAuthServerConfig,
  generatePkcePair,
  registerDynamicClient,
  type OAuthDiscoveryOptions,
  type OAuthServerConfig,
} from './oauth-discovery.js'

/**
 * OAuth handshake for MCP server instances. Two modes share one entry point:
 *
 * - **Static** — the catalog entry's `oauth2` config carries a full
 *   pre-registered client (authorizationUrl/tokenUrl/clientId[/clientSecret]).
 *   The original flow, kept for vendors without dynamic registration.
 * - **Dynamic** (MCP authorization spec 2025-06-18) — the config carries only
 *   `{ method: "oauth2" }`. We discover the protected-resource + authorization
 *   -server metadata from the instance's endpoint (RFC 9728 / RFC 8414),
 *   register a public client on the fly when the server supports RFC 7591
 *   (one per organization × issuer, persisted in `mcp_oauth_clients`), and run
 *   authorization-code **with PKCE (S256)** and the RFC 8707 `resource`
 *   indicator.
 *
 * State is one-shot and Postgres-backed (`mcp_oauth_states`) so a flow minted
 * by one process (e.g. the worker's personal assistant) can be completed by
 * another (the API callback). Tokens are stored refreshable: the secret
 * bundle carries the token endpoint + client so the resolver can refresh
 * expired access tokens transparently at dispatch time.
 *
 * The service NEVER returns or logs raw access/refresh tokens.
 */

export const MCP_OAUTH_ERROR_CODES = {
  INSTANCE_NOT_FOUND: 'MCP_OAUTH_INSTANCE_NOT_FOUND',
  CATALOG_ENTRY_NOT_FOUND: 'MCP_OAUTH_CATALOG_ENTRY_NOT_FOUND',
  NOT_OAUTH2: 'MCP_OAUTH_NOT_OAUTH2',
  DISCOVERY_FAILED: 'MCP_OAUTH_DISCOVERY_FAILED',
  REGISTRATION_FAILED: 'MCP_OAUTH_REGISTRATION_FAILED',
  STATE_INVALID: 'MCP_OAUTH_STATE_INVALID',
  STATE_EXPIRED: 'MCP_OAUTH_STATE_EXPIRED',
  URL_UNSAFE: 'MCP_OAUTH_URL_UNSAFE',
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
 * One-shot authorization state. Carries everything the callback needs so the
 * dynamic flow never has to re-discover metadata (which could have changed
 * between start and callback — TOCTOU on the token endpoint).
 */
export type OAuthStateRecord = {
  instanceId: string
  organizationId: string
  actorId: string
  /** epoch ms when this state token expires */
  expiresAt: number
  mode: 'static' | 'dynamic'
  redirectUri: string
  /** PKCE verifier (dynamic mode always; static mode never — back-compat). */
  codeVerifier?: string
  /** Dynamic-mode client + endpoints resolved at start time. */
  clientId?: string
  clientSecretRef?: string
  tokenEndpoint?: string
  resource?: string
}

export type OAuthStateStore = {
  put: (token: string, record: OAuthStateRecord) => Promise<void>
  take: (token: string) => Promise<OAuthStateRecord | null>
}

/** In-memory state store for unit tests / single-process fallbacks. */
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
    put: async (token, record) => {
      purgeExpired(Date.now())
      map.set(token, record)
    },
    take: async (token) => {
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
 * Postgres-backed state store (`mcp_oauth_states`) — the production default.
 * Works across processes: the worker's personal assistant can mint a flow the
 * API's callback completes. Rows are deleted on first read (one-shot) and
 * expired rows are purged opportunistically on every write.
 */
export const createPgOAuthStateStore = (prisma: PrismaClient): OAuthStateStore => ({
  put: async (token, record) => {
    await prisma.mcpOAuthState.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    })
    const { expiresAt, ...payload } = record
    await prisma.mcpOAuthState.create({
      data: {
        token,
        payload: payload as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(expiresAt),
      },
    })
  },
  take: async (token) => {
    let row: { payload: unknown; expiresAt: Date }
    try {
      row = await prisma.mcpOAuthState.delete({ where: { token } })
    } catch {
      return null
    }
    if (row.expiresAt.getTime() <= Date.now()) return null
    const payload = row.payload as Omit<OAuthStateRecord, 'expiresAt'>
    return { ...payload, expiresAt: row.expiresAt.getTime() }
  },
})

/**
 * Per-process singleton in-memory store, kept as the zero-config default for
 * tests. Routes and the worker wire `createPgOAuthStateStore` explicitly.
 */
export const defaultOAuthStateStore = createInMemoryStateStore()

const STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes per task #20 spec.

const mapSecurityError = (error: unknown): never => {
  if (error instanceof McpSecurityError) {
    throw new McpOAuthError(MCP_OAUTH_ERROR_CODES.URL_UNSAFE, error.message)
  }
  throw error
}

/**
 * Mint a cryptographically random `state` parameter. `base64url` keeps the
 * token URL-safe so providers don't mangle it in redirects.
 */
export const generateState = (): string =>
  crypto.randomBytes(32).toString('base64url')

/**
 * Contract for persisting raw token material behind an opaque ref. The
 * refresh-related fields (tokenEndpoint/clientId/…) ride inside the encrypted
 * bundle so the resolver can renew expired access tokens without any extra
 * lookups. Production deployments MUST inject the encrypted Postgres store.
 */
export type SecretStore = {
  put: (input: {
    accessToken: string
    refreshToken?: string
    expiresIn?: number
    tokenType?: string
    /** Refresh metadata (dynamic OAuth). */
    tokenEndpoint?: string
    clientId?: string
    clientSecret?: string
    resource?: string
  }) => Promise<string>
}

/** Test-only stub: mints refs, drops the material. */
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

// ─── Dynamic client persistence ─────────────────────────────────────────────

/**
 * Find or register the organization's OAuth client for an authorization
 * server. Clients are public (`token_endpoint_auth_method: none`, PKCE) and
 * shared by every instance in the org that talks to the same issuer. A client
 * registered for a different callback URL (e.g. the deployment moved hosts)
 * is re-registered.
 */
export const ensureDynamicClient = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    config: OAuthServerConfig
    redirectUri: string
    secretStore?: SecretStore
    discovery?: OAuthDiscoveryOptions
  },
): Promise<{ clientId: string; clientSecretRef: string | null }> => {
  const existing = await prisma.mcpOAuthClient.findUnique({
    where: {
      organizationId_issuer: {
        organizationId: input.organizationId,
        issuer: input.config.issuer,
      },
    },
  })
  if (existing && existing.redirectUris.includes(input.redirectUri)) {
    return { clientId: existing.clientId, clientSecretRef: existing.clientSecretRef }
  }
  if (!input.config.registrationEndpoint) {
    if (existing) {
      // Can't re-register; reuse and hope the provider accepts the redirect.
      return { clientId: existing.clientId, clientSecretRef: existing.clientSecretRef }
    }
    throw new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.REGISTRATION_FAILED,
      'Authorization server does not support dynamic client registration; '
        + 'configure a static OAuth client on the catalog entry instead',
    )
  }

  let registration
  try {
    registration = await registerDynamicClient(
      {
        registrationEndpoint: input.config.registrationEndpoint,
        redirectUris: [input.redirectUri],
        clientName: 'Nessie',
      },
      input.discovery,
    )
  } catch (error) {
    throw new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.REGISTRATION_FAILED,
      error instanceof Error ? error.message : String(error),
    )
  }

  // A public client shouldn't get a secret, but when a server issues one
  // anyway it must survive only encrypted behind a ref.
  const clientSecretRef =
    registration.clientSecret && input.secretStore
      ? await input.secretStore.put({ accessToken: registration.clientSecret })
      : null

  const row = await prisma.mcpOAuthClient.upsert({
    where: {
      organizationId_issuer: {
        organizationId: input.organizationId,
        issuer: input.config.issuer,
      },
    },
    create: {
      organizationId: input.organizationId,
      issuer: input.config.issuer,
      clientId: registration.clientId,
      clientSecretRef,
      redirectUris: [input.redirectUri],
      metadata: registration.raw as Prisma.InputJsonValue,
    },
    update: {
      clientId: registration.clientId,
      clientSecretRef,
      redirectUris: [input.redirectUri],
      metadata: registration.raw as Prisma.InputJsonValue,
    },
  })
  return { clientId: row.clientId, clientSecretRef: row.clientSecretRef }
}

// ─── start ──────────────────────────────────────────────────────────────────

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
  /** Needed in dynamic mode when a registration returns a client secret. */
  secretStore?: SecretStore
  discovery?: OAuthDiscoveryOptions
  resolveHost?: McpUrlSafetyOptions['resolveHost']
}

export type StartOAuthResult = {
  authorizationUrl: string
  state: string
  mode: 'static' | 'dynamic'
}

const hasStaticOAuthConfig = (
  config: McpOAuth2AuthConfig,
): config is McpOAuth2AuthConfig & {
  authorizationUrl: string
  tokenUrl: string
  clientId: string
} =>
  typeof config.authorizationUrl === 'string'
  && config.authorizationUrl.length > 0
  && typeof config.tokenUrl === 'string'
  && config.tokenUrl.length > 0
  && typeof config.clientId === 'string'
  && config.clientId.length > 0

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

  if (hasStaticOAuthConfig(parsed)) {
    try {
      await assertMcpAuthUrlsSafe(parsed, { resolveHost: input.resolveHost })
    } catch (error) {
      mapSecurityError(error)
    }

    await store.put(token, {
      instanceId,
      organizationId,
      actorId: actorContext.actor.actorId,
      expiresAt: Date.now() + STATE_TTL_MS,
      mode: 'static',
      redirectUri: callbackUrl,
    })

    // Per RFC 6749 §4.1.1 the authorization request MUST carry `client_id`.
    const authUrl = new URL(parsed.authorizationUrl)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('client_id', parsed.clientId)
    authUrl.searchParams.set('state', token)
    authUrl.searchParams.set('redirect_uri', callbackUrl)
    if (parsed.scopes.length > 0) {
      authUrl.searchParams.set('scope', parsed.scopes.join(' '))
    }
    return { authorizationUrl: authUrl.toString(), state: token, mode: 'static' }
  }

  // ── Dynamic mode: discover metadata from the instance's endpoint. ────────
  const transport = resolveInstanceTransport(instance, catalogEntry)
  if (transport.transport !== 'http' && transport.transport !== 'sse') {
    throw new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.DISCOVERY_FAILED,
      'Dynamic OAuth requires an HTTP/SSE remote endpoint',
    )
  }
  const config = await discoverOAuthServerConfig(transport.url, {
    ...input.discovery,
    resolveHost: input.resolveHost ?? input.discovery?.resolveHost,
  })
  if (!config) {
    throw new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.DISCOVERY_FAILED,
      'This server publishes no OAuth metadata. If it expects an API key, '
        + 'set a credential instead.',
    )
  }
  try {
    await assertMcpUrlSafe(config.authorizationEndpoint, { resolveHost: input.resolveHost })
    await assertMcpUrlSafe(config.tokenEndpoint, { resolveHost: input.resolveHost })
  } catch (error) {
    mapSecurityError(error)
  }

  const client = await ensureDynamicClient(prisma, {
    organizationId,
    config,
    redirectUri: callbackUrl,
    secretStore: input.secretStore,
    discovery: input.discovery,
  })

  const pkce = generatePkcePair()
  await store.put(token, {
    instanceId,
    organizationId,
    actorId: actorContext.actor.actorId,
    expiresAt: Date.now() + STATE_TTL_MS,
    mode: 'dynamic',
    redirectUri: callbackUrl,
    codeVerifier: pkce.verifier,
    clientId: client.clientId,
    clientSecretRef: client.clientSecretRef ?? undefined,
    tokenEndpoint: config.tokenEndpoint,
    resource: config.resource,
  })

  const authUrl = new URL(config.authorizationEndpoint)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', client.clientId)
  authUrl.searchParams.set('state', token)
  authUrl.searchParams.set('redirect_uri', callbackUrl)
  if (config.supportsS256) {
    authUrl.searchParams.set('code_challenge', pkce.challenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
  }
  // RFC 8707: bind the token to the MCP server so an AS serving several
  // resources can't be tricked into minting a token for the wrong one.
  authUrl.searchParams.set('resource', config.resource)
  if (config.scopesSupported.length > 0) {
    authUrl.searchParams.set('scope', config.scopesSupported.join(' '))
  }
  return { authorizationUrl: authUrl.toString(), state: token, mode: 'dynamic' }
}

// ─── token exchange ─────────────────────────────────────────────────────────

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
  clientSecret?: string
  codeVerifier?: string
  resource?: string
  resolveHost?: McpUrlSafetyOptions['resolveHost']
}) => Promise<{
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  tokenType?: string
}>

/**
 * RFC 6749 §4.1.3 authorization_code exchange. Confidential clients
 * authenticate via the request body (§2.3.1 — avoids providers that reject
 * Basic); public clients send `client_id` alone with the PKCE
 * `code_verifier` (RFC 7636 §4.5). `resource` is RFC 8707.
 */
export const defaultTokenExchange: TokenExchangeFn = async ({
  tokenUrl,
  code,
  redirectUri,
  clientId,
  clientSecret,
  codeVerifier,
  resource,
  resolveHost,
}) => {
  try {
    await assertMcpUrlSafe(tokenUrl, { resolveHost })
  } catch (error) {
    mapSecurityError(error)
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
  })
  if (clientSecret) body.set('client_secret', clientSecret)
  if (codeVerifier) body.set('code_verifier', codeVerifier)
  if (resource) body.set('resource', resource)
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

// ─── complete ───────────────────────────────────────────────────────────────

export type CompleteOAuthInput = {
  prisma: PrismaClient
  store?: OAuthStateStore
  secretStore: SecretStore
  /** Resolves a dynamic client's secret ref, when one was issued. */
  secretResolver?: { resolve: (ref: string) => Promise<string | null> }
  tokenExchange?: TokenExchangeFn
  state: string
  code: string
  callbackUrl: string
  resolveHost?: McpUrlSafetyOptions['resolveHost']
}

/**
 * Public response shape for `completeOAuth`. Deliberately excludes the
 * internal `credentialRef` — that opaque secret pointer must never cross the
 * API boundary.
 */
export type CompleteOAuthResult = {
  instanceId: string
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
  const record = await store.take(input.state)
  if (!record) {
    // `take` returns null both for unknown tokens and for expired ones; we
    // surface the expired-vs-invalid distinction as a single code because the
    // server-side state row has already been deleted in either case.
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

  let exchangeParams: Parameters<TokenExchangeFn>[0]
  if (record.mode === 'dynamic') {
    if (!record.tokenEndpoint || !record.clientId) {
      throw new McpOAuthError(
        MCP_OAUTH_ERROR_CODES.STATE_INVALID,
        'state record is missing dynamic-flow parameters',
      )
    }
    const clientSecret =
      record.clientSecretRef && input.secretResolver
        ? (await input.secretResolver.resolve(record.clientSecretRef)) ?? undefined
        : undefined
    exchangeParams = {
      tokenUrl: record.tokenEndpoint,
      code: input.code,
      redirectUri: record.redirectUri ?? input.callbackUrl,
      clientId: record.clientId,
      clientSecret,
      codeVerifier: record.codeVerifier,
      resource: record.resource,
      resolveHost: input.resolveHost,
    }
  } else {
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
    if (!hasStaticOAuthConfig(parsed)) {
      throw new McpOAuthError(
        MCP_OAUTH_ERROR_CODES.STATE_INVALID,
        'catalog entry no longer carries a static OAuth client',
      )
    }
    try {
      await assertMcpAuthUrlsSafe(parsed, { resolveHost: input.resolveHost })
    } catch (error) {
      mapSecurityError(error)
    }
    exchangeParams = {
      tokenUrl: parsed.tokenUrl,
      code: input.code,
      redirectUri: record.redirectUri ?? input.callbackUrl,
      clientId: parsed.clientId,
      clientSecret: parsed.clientSecret,
      resolveHost: input.resolveHost,
    }
  }

  const tokens = await tokenExchange(exchangeParams)
  const credentialRef = await input.secretStore.put({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    tokenType: tokens.tokenType,
    // Refresh metadata: lets the resolver renew the access token in place.
    tokenEndpoint: exchangeParams.tokenUrl,
    clientId: exchangeParams.clientId,
    clientSecret: exchangeParams.clientSecret,
    resource: record.resource,
  })

  // Placement mirrors `storeInstanceSecret`: the user's own user-scope
  // instance takes the token as its connection credential (so probes work);
  // shared instances get a per-user override so different users keep separate
  // OAuth identities (the override outranks the instance default in the
  // 7-level resolution chain).
  if (instance.scopeType === 'user' && instance.scopeId === record.actorId) {
    await input.prisma.mcpServerInstance.update({
      where: { id: instance.id },
      data: { credentialRef },
    })
  } else {
    await input.prisma.mcpServerCredentialOverride.upsert({
      where: {
        instanceId_principalType_principalId: {
          instanceId: record.instanceId,
          principalType: 'user',
          principalId: record.actorId,
        },
      },
      create: {
        instanceId: record.instanceId,
        principalType: 'user',
        principalId: record.actorId,
        credentialRef,
      },
      update: { credentialRef },
    })
  }

  return {
    instanceId: record.instanceId,
  }
}

/**
 * Whether an actor may start an OAuth flow for an instance: anyone who can
 * reach it. The minted token only ever lands on the caller's own identity
 * (their user-scope instance or their per-user override), so this is
 * self-service by construction — unlike credential *management*, which stays
 * scope-gated.
 */
export const canStartOAuthForInstance = async (
  prisma: PrismaClient,
  organizationId: string,
  userId: string,
  instance: { scopeType: string; scopeId: string },
): Promise<boolean> => {
  if (instance.scopeType === 'user') return instance.scopeId === userId
  if (instance.scopeType === 'organization' || instance.scopeType === 'system') return true
  const access = await resolveMcpUserAccess(prisma, organizationId, userId)
  if (access.role === 'owner' || access.role === 'admin') return true
  switch (instance.scopeType) {
    case 'team':
      return access.teamIds.includes(instance.scopeId)
    case 'channel':
      return access.channelIds.includes(instance.scopeId)
    case 'project':
      return access.projectIds.includes(instance.scopeId)
    default:
      return false
  }
}
