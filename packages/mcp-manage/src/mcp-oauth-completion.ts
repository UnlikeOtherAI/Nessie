import { isAdminRole } from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'
import type { McpOAuth2AuthConfig } from '@nessie/schemas'

import {
  ensureAuthConfigMatchesMethod,
  getCatalogEntry,
} from './mcp-catalog.js'
import { getInstance, resolveMcpUserAccess } from './mcp-instances.js'
import type { ManagerFactory } from './mcp-instance-probe.js'
import { testInstance } from './mcp-instance-testing.js'
import {
  assertMcpAuthUrlsSafe,
  mcpSafeFetch,
  type McpUrlSafetyOptions,
} from './mcp-security.js'
import { isManagedIntegrationCatalogEntry } from './managed-products.js'
import type { SecretResolver } from './secret-resolver.js'
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
  /**
   * Resolves a dynamic client's secret ref during the exchange, and the token
   * this callback just stored during the probe that follows it.
   */
  secretResolver?: SecretResolver
  tokenExchange?: TokenExchangeFn
  /**
   * Probe seam, exactly as `testInstance` takes it — so the post-exchange
   * handshake is exercisable offline instead of only in production.
   */
  managerFactory?: ManagerFactory
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
 * Finish the connection now that a credential exists: probe the server with
 * it, which is what moves the instance off `pending_setup` and projects its
 * tools. Without this the App Store reads the row as `connecting` forever, so
 * a person who has just signed in successfully watches their verification poll
 * exhaust and is told nothing was saved — while Capabilities and Agents stay
 * empty because nothing was ever projected.
 *
 * This calls `testInstance` directly rather than a hook the caller supplies.
 * An optional hook would fail open and silently — a caller that forgot to pass
 * one reproduces exactly the defect being fixed here, on a path where the
 * symptom is a false failure message rather than an exception. The import is
 * also not a dependency inversion: `mcp-instance-testing` imports nothing from
 * the OAuth layer, so the edge is acyclic and runs the same direction as this
 * module's existing `mcp-instances` / `mcp-catalog` imports.
 *
 * A probe failure is deliberately swallowed. The authorization really did
 * succeed and the token really is stored, so failing the callback would tell
 * the person the opposite of what happened; `testInstance` has already written
 * the failure and its reason onto the instance row, which is where the
 * connections surface reads it from. Writing a second lifecycle state here
 * would fork that one writer.
 */
const probeStoredCredential = async (
  input: Pick<CompleteOAuthInput, 'prisma' | 'secretResolver' | 'managerFactory'>,
  target: { organizationId: string; instanceId: string; probeUserId: string },
): Promise<void> => {
  try {
    await testInstance(input.prisma, target.organizationId, target.instanceId, {
      probeUserId: target.probeUserId,
      secretResolver: input.secretResolver,
      managerFactory: input.managerFactory,
    })
  } catch {
    // Intentionally terminal — see the doc comment above.
  }
}

/**
 * Consume one-shot state, exchange the code, persist the resulting token
 * bundle, and probe the instance with it so the connection ends in a state a
 * person can act on. Managed first-party products reject old OAuth callbacks
 * before any exchange, keeping their deployment app credentials authoritative.
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
      // `startOAuth` authorizes static mode with a PKCE challenge too, and per
      // RFC 7636 §4.6 a server that recorded one MUST reject a token request
      // that omits its verifier. Sending the challenge and then withholding
      // the verifier fails every static-mode connector at the last step — and
      // proves nothing on a server lenient enough to let it through.
      codeVerifier: record.codeVerifier,
      // RFC 8707: the token request repeats the resource the authorization
      // request was bound to, or the server may mint a token for a different
      // audience than the one the person approved.
      resource: record.resource,
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

  await probeStoredCredential(input, {
    organizationId: record.organizationId,
    instanceId: record.instanceId,
    probeUserId: record.actorId,
  })
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
  if (isAdminRole(access.role)) return true
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
