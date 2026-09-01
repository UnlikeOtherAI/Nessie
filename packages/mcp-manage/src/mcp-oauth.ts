import type { Prisma, PrismaClient } from '@prisma/client'
import type {
  AuthorizedActionContext,
  McpOAuth2AuthConfig,
} from '@nessie/schemas'

import { getCatalogEntry, ensureAuthConfigMatchesMethod } from './mcp-catalog.js'
import { getInstance, type McpInstanceRow } from './mcp-instances.js'
import { isManagedIntegrationCatalogEntry } from './managed-products.js'
import { resolveInstanceTransport } from './mcp-instance-probe.js'
import {
  assertMcpAuthUrlsSafe,
  assertMcpUrlSafe,
  type McpUrlSafetyOptions,
} from './mcp-security.js'
import {
  canonicalResource,
  discoverOAuthServerConfig,
  generatePkcePair,
  OAuthDiscoveryError,
  registerDynamicClient,
  type OAuthDiscoveryOptions,
  type OAuthServerConfig,
} from './oauth-discovery.js'
import {
  resolveOAuthClientStrategy,
  type OAuthClientResolutionConfig,
  type OAuthClientStrategy,
} from './oauth-client-resolution.js'
import {
  MCP_OAUTH_ERROR_CODES,
  McpOAuthError,
  mapOAuthSecurityError,
} from './mcp-oauth-errors.js'
import {
  STATE_TTL_MS,
  defaultOAuthStateStore,
  generateState,
  type OAuthStateStore,
} from './mcp-oauth-state.js'

/**
 * Client selection and state persistence are halves of starting a flow, so the
 * package barrel reaches both through this module — one export path each, no
 * second star export to keep in step.
 */
export * from './mcp-oauth-errors.js'
export * from './oauth-client-resolution.js'
export * from './mcp-oauth-state.js'

/**
 * OAuth handshake for MCP server instances. Two modes share one entry point:
 *
 * - **Static** — the catalog entry's `oauth2` config carries a full
 *   pre-registered client (authorizationUrl/tokenUrl/clientId[/clientSecret]).
 *   The original flow, kept for vendors without dynamic registration.
 * - **Dynamic** (MCP authorization spec 2025-06-18) — the config carries only
 *   `{ method: "oauth2" }`. We discover the protected-resource + authorization
 *   -server metadata from the instance's endpoint (RFC 9728 / RFC 8414), then
 *   pick a client through the one preference order in
 *   `oauth-client-resolution.ts` (pre-registered → client-ID metadata document
 *   → RFC 7591 registration → operator-supplied).
 *
 * Both modes run authorization-code **with PKCE (S256)** and the RFC 8707
 * `resource` indicator. Static mode had neither until the App Store connect
 * flow; a pre-registered client is not a reason to redeem a stolen code
 * without proof of possession.
 *
 * State is one-shot and Postgres-backed (`mcp_oauth_states`) so a flow minted
 * by one process (e.g. the worker's personal assistant) can be completed by
 * another (the API callback). Tokens are stored refreshable: the secret
 * bundle carries the token endpoint + client so the resolver can refresh
 * expired access tokens transparently at dispatch time.
 *
 * The service NEVER returns or logs raw access/refresh tokens.
 */

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
      error instanceof OAuthDiscoveryError && error.status === 403
        ? MCP_OAUTH_ERROR_CODES.CLIENT_APPROVAL_REQUIRED
        : MCP_OAUTH_ERROR_CODES.REGISTRATION_FAILED,
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

/**
 * Turn a resolved strategy into the (clientId, clientSecretRef) pair the state
 * record carries. A secret we are handed in plaintext goes into the encrypted
 * vault first: `mcp_oauth_states.payload` is ordinary application data and
 * must never hold credential material.
 */
const clientForStrategy = async (
  prisma: PrismaClient,
  strategy: OAuthClientStrategy,
  context: {
    organizationId: string
    config: OAuthServerConfig
    redirectUri: string
    secretStore?: SecretStore
    discovery?: OAuthDiscoveryOptions
  },
): Promise<{ clientId: string; clientSecretRef: string | null }> => {
  switch (strategy.source) {
    case 'dynamic_registration':
      return ensureDynamicClient(prisma, context)
    case 'client_id_metadata_document':
      // The document's URL is the whole identity — nothing registered, no secret.
      return { clientId: strategy.clientId, clientSecretRef: null }
    case 'pre_registered':
    case 'operator': {
      if (!strategy.clientSecret) {
        return { clientId: strategy.clientId, clientSecretRef: null }
      }
      if (!context.secretStore) {
        throw new McpOAuthError(
          MCP_OAUTH_ERROR_CODES.REGISTRATION_FAILED,
          'A client secret is configured for this authorization server but no '
            + 'secret store is available to hold it',
        )
      }
      return {
        clientId: strategy.clientId,
        clientSecretRef: await context.secretStore.put({
          accessToken: strategy.clientSecret,
        }),
      }
    }
  }
}

/**
 * RFC 8707 resource indicator for the static path, taken from the instance's
 * own transport. Omitted rather than fatal when that transport is not an
 * HTTP/SSE remote or does not parse: a malformed transport is the probe's
 * error to report, and an authorize URL is not where a person should meet it.
 */
const staticResourceIndicator = (
  instance: McpInstanceRow,
  catalogEntry: { defaultTransportConfig: unknown },
): string | undefined => {
  try {
    const transport = resolveInstanceTransport(instance, catalogEntry)
    if (transport.transport !== 'http' && transport.transport !== 'sse') {
      return undefined
    }
    return canonicalResource(transport.url)
  } catch {
    return undefined
  }
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
  /**
   * Deployment client configuration (published CIMD document, operator-named
   * clients). Omitted, resolution falls through to dynamic registration —
   * exactly what every existing caller already gets.
   */
  clientResolution?: OAuthClientResolutionConfig
}

export type StartOAuthResult = {
  authorizationUrl: string
  state: string
  mode: 'static' | 'dynamic'
}

export const hasStaticOAuthConfig = (
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
  if (await isManagedIntegrationCatalogEntry(prisma, catalogEntry.id)) {
    throw new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.NOT_OAUTH2,
      'This first-party connector does not accept per-user OAuth credentials.',
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
      mapOAuthSecurityError(error)
    }

    // Tier 1 of the one preference order: a client registered for this app by
    // a human, so no discovered mechanism can outrank it.
    const strategy = resolveOAuthClientStrategy({
      preRegistered: { clientId: parsed.clientId, clientSecret: parsed.clientSecret },
      config: input.clientResolution,
    })
    if (strategy.source !== 'pre_registered') {
      throw new McpOAuthError(
        MCP_OAUTH_ERROR_CODES.REGISTRATION_FAILED,
        'Static OAuth client could not be resolved for this catalog entry',
      )
    }

    // PKCE (RFC 7636) is not optional here just because the client was
    // pre-registered: without it a stolen authorization code is redeemable by
    // anyone who reaches the token endpoint.
    const pkce = generatePkcePair()
    const resource = staticResourceIndicator(instance, catalogEntry)

    await store.put(token, {
      instanceId,
      organizationId,
      actorId: actorContext.actor.actorId,
      expiresAt: Date.now() + STATE_TTL_MS,
      mode: 'static',
      redirectUri: callbackUrl,
      codeVerifier: pkce.verifier,
      ...(resource ? { resource } : {}),
    })

    // Per RFC 6749 §4.1.1 the authorization request MUST carry `client_id`.
    const authUrl = new URL(parsed.authorizationUrl)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('client_id', strategy.clientId)
    authUrl.searchParams.set('state', token)
    authUrl.searchParams.set('redirect_uri', callbackUrl)
    authUrl.searchParams.set('code_challenge', pkce.challenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    // RFC 8707: bind the token to this MCP server. An authorization server
    // that has never heard of the parameter MUST ignore it (RFC 6749 §3.1),
    // so this is safe against the vendors that predate the indicator.
    if (resource) {
      authUrl.searchParams.set('resource', resource)
    }
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
    mapOAuthSecurityError(error)
  }

  // Tiers 2–4: only now do we know what this authorization server supports.
  const strategy = resolveOAuthClientStrategy({
    server: {
      issuer: config.issuer,
      registrationEndpoint: config.registrationEndpoint,
      supportsClientIdMetadataDocument: config.supportsClientIdMetadataDocument,
    },
    config: input.clientResolution,
  })
  const client = await clientForStrategy(prisma, strategy, {
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
