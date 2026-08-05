import type { PrismaClient } from '@prisma/client'
import type { McpOAuth2AuthConfig } from '@nessie/schemas'

import {
  ensureAuthConfigMatchesMethod,
  getCatalogEntry,
} from './mcp-catalog.js'
import { getInstance, resolveMcpUserAccess } from './mcp-instances.js'
import {
  assertMcpAuthUrlsSafe,
  mcpSafeFetch,
  type McpUrlSafetyOptions,
} from './mcp-security.js'
import { isManagedIntegrationCatalogEntry } from './managed-products.js'
import {
  MCP_OAUTH_ERROR_CODES,
  McpOAuthError,
  defaultOAuthStateStore,
  hasStaticOAuthConfig,
  mapOAuthSecurityError,
  type OAuthStateStore,
  type SecretStore,
} from './mcp-oauth.js'

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
 * authenticate via the request body; public clients send `client_id` with the
 * PKCE verifier. `resource` binds the token per RFC 8707.
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
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
  })
  if (clientSecret) body.set('client_secret', clientSecret)
  if (codeVerifier) body.set('code_verifier', codeVerifier)
  if (resource) body.set('resource', resource)
  // The client secret rides in this body, so the socket must be pinned to the
  // address the guard vetted and every redirect re-checked: a validated public
  // token endpoint that 3xx'd to an internal host would otherwise leak it.
  let response: Response
  try {
    response = await mcpSafeFetch(
      tokenUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
      },
      { resolveHost },
    )
  } catch (error) {
    mapOAuthSecurityError(error)
    throw error
  }
  if (response.status >= 300 && response.status < 400) {
    throw new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.TOKEN_EXCHANGE_FAILED,
      'Token endpoint attempted a redirect',
    )
  }
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

/** Public result deliberately excludes the internal credential reference. */
export type CompleteOAuthResult = {
  instanceId: string
}

/**
 * Consume one-shot state, exchange the code, and persist the resulting token
 * bundle. Managed first-party products reject old OAuth callbacks before any
 * exchange, keeping their deployment app credentials authoritative.
 */
export const completeOAuth = async (
  input: CompleteOAuthInput,
): Promise<CompleteOAuthResult> => {
  const store = input.store ?? defaultOAuthStateStore
  const tokenExchange = input.tokenExchange ?? defaultTokenExchange

  if (!input.state) {
    throw new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.STATE_INVALID,
      'state parameter is required',
    )
  }
  const record = await store.take(input.state)
  if (!record) {
    throw new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.STATE_INVALID,
      'state token is invalid or expired',
    )
  }
  if (!input.code) {
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
  if (
    await isManagedIntegrationCatalogEntry(
      input.prisma,
      instance.catalogEntryId,
    )
  ) {
    throw new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.NOT_OAUTH2,
      'This first-party connector no longer accepts per-user OAuth credentials.',
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
      redirectUri: record.redirectUri,
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
      mapOAuthSecurityError(error)
    }
    exchangeParams = {
      tokenUrl: parsed.tokenUrl,
      code: input.code,
      redirectUri: record.redirectUri,
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
    tokenEndpoint: exchangeParams.tokenUrl,
    clientId: exchangeParams.clientId,
    clientSecret: exchangeParams.clientSecret,
    resource: record.resource,
  })

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
  return { instanceId: record.instanceId }
}

/**
 * A reachable OAuth instance can mint a credential only for the caller's own
 * identity. Credential management remains separately scope-gated.
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
