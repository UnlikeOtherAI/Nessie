import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  COMMS_SYNC_INITIAL_TOPIC,
  CommsConnectionStartResponseSchema,
  CommsConnectionStartRequestSchema,
  CommsProviderSchema,
  CommsProvidersResponseSchema,
  DEFAULT_GOOGLE_CAPABILITIES,
  scopesForCapabilities,
  type CommsProvider,
  type GoogleCapabilityId,
} from '@nessie/schemas'
import {
  ConnectorNotRegisteredError,
  resolveConnector,
} from '@nessie/comms-connect'
import { enqueueQueueJob, writeAuditEntry } from '@nessie/db'

import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import { PublicOriginConfigError } from '../../lib/public-origin.js'
import type { RouteDeps } from '../types.js'
import {
  buildAuthorizeUrl,
  buildCommsCallbackUrl,
  generateOAuthNonce,
  generateOAuthStateToken,
  generatePkcePair,
  getCommsOAuthConfig,
  isCommsProviderConnectable,
} from './oauth-config.js'
import { persistConnectedAccount } from './persist.js'

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

export const parseProviderParam = (
  request: FastifyRequest,
): CommsProvider | null => {
  const { provider } = request.params as { provider?: string }
  const parsed = CommsProviderSchema.safeParse(provider)
  return parsed.success ? parsed.data : null
}

/**
 * What the callback needs to finish a flow it did not start. Everything here is
 * server-authored at `/start`; nothing is read from the callback query string
 * except the opaque code and state.
 */
type CommsOAuthStatePayload = {
  redirectUri?: string
  codeVerifier?: string | null
  /** OIDC nonce for a provider that returns an id_token identity assertion. */
  nonce?: string | null
  /** The connection this flow is re-authorizing, when it is not a first connect. */
  targetConnectionId?: string | null
  /**
   * The provider account that must come back. Without this the callback
   * persists whichever account finished consent, so adding Calendar to a work
   * account while signed into a personal one silently re-points the mailbox.
   */
  expectedAccountId?: string | null
  /** Capability ids asked for, recorded so the UI can show asked-but-declined. */
  capabilities?: string[]
}

/** Provider adapters expose only structural, safe error markers to this route. */
export const callbackErrorCode = (error: unknown): string => {
  if (typeof error !== 'object' || error === null) return 'connect_failed'
  const typed = error as {
    authorizationBlocked?: unknown
    needsReauthorization?: unknown
  }
  if (typed.authorizationBlocked === true) return 'provider_access_blocked'
  if (typed.needsReauthorization === true) return 'reauthorization_required'
  return 'connect_failed'
}

// OAuth callback query parameters are provider-controlled and untrusted. Only
// these documented structural consent-policy values receive a tailored UI
// state; every other error is the ordinary cancelled/denied flow. In
// particular, `error_description` is intentionally never inspected or shown.
const PROVIDER_ACCESS_BLOCKED_QUERY_ERRORS = new Set([
  'admin_consent_required',
  'authorization_required',
  'consent_required',
])

export const callbackQueryErrorCode = (error: string): string =>
  PROVIDER_ACCESS_BLOCKED_QUERY_ERRORS.has(error)
    ? 'provider_access_blocked'
    : 'access_denied'

export const registerCommsOAuthRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { config, prisma, requireActorContext, authSecret } = deps

  const adminBaseUrl = (): string => {
    const configured =
      process.env.NESSIE_ADMIN_PUBLIC_URL ?? process.env.NESSIE_ADMIN_ORIGIN
    if (configured) return configured.replace(/\/$/, '')
    return config.mode === 'local' ? 'http://localhost:5455' : ''
  }

  const redirectToConnections = (
    reply: FastifyReply,
    params: Record<string, string>,
  ): FastifyReply => {
    const query = new URLSearchParams(params).toString()
    reply.redirect(`${adminBaseUrl()}/settings/connections?${query}`)
    return reply
  }

  // ── GET /api/comms/providers ──────────────────────────────────────────────
  // What this deployment can actually finish. A surface that offers provider
  // buttons asks here first: `/start` can only refuse an unconfigured provider
  // after the click, and a refusal at that point is indistinguishable from a
  // fault to the person who clicked.
  app.get('/api/comms/providers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    return createApiResponse(
      CommsProvidersResponseSchema.parse({
        providers: CommsProviderSchema.options.map((provider) => ({
          provider,
          available: isCommsProviderConnectable(provider),
        })),
      }),
    )
  })

  // ── POST /api/comms/connections/:provider/start ───────────────────────────
  app.post('/api/comms/connections/:provider/start', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const provider = parseProviderParam(request)
    if (!provider) {
      sendApiError(reply, 400, 'VALIDATION_ERROR', 'Unknown provider')
      return reply
    }

    const oauthConfig = getCommsOAuthConfig(provider)
    if (!oauthConfig) {
      sendApiError(
        reply,
        501,
        'NOT_IMPLEMENTED',
        `Connecting ${provider} is not available yet`,
      )
      return reply
    }

    // Deployment configuration, not a fault: 503 so the browser can say what
    // is actually wrong instead of offering a retry that cannot succeed. The
    // whole registration is checked here rather than the client id alone,
    // because a half-configured provider would otherwise reach the provider's
    // consent screen and only fail on the way back.
    const clientId = process.env[oauthConfig.clientIdEnv]
    if (!clientId || !isCommsProviderConnectable(provider)) {
      sendApiError(
        reply,
        503,
        'PROVIDER_NOT_CONFIGURED',
        `${provider} sign-in is not set up on this server`,
      )
      return reply
    }

    // An empty body keeps the pre-catalog behaviour exactly.
    const body = parseInput(
      CommsConnectionStartRequestSchema,
      request.body ?? {},
      reply,
    )
    if (!body) return reply

    // Only Google has a capability catalog today; another provider naming
    // capabilities is a caller error rather than a silently ignored field.
    if (provider !== 'google' && body.capabilities) {
      sendApiError(
        reply,
        400,
        'VALIDATION_ERROR',
        `${provider} does not support capability selection`,
      )
      return reply
    }

    // Re-authorizing an existing connection: load it first so the request can
    // ask for the union of what it already holds, and so the callback can
    // verify the same account came back.
    let target: {
      id: string
      externalUserId: string
      providerAccountId: string | null
      grantedScopes: string[]
    } | null = null
    if (body.connectionId) {
      const row = await prisma.commsConnection.findFirst({
        where: {
          id: body.connectionId,
          organizationId: actorContext.tenant.organizationId,
          ownerUserId: actorContext.actor.actorId,
          provider,
        },
        select: {
          id: true,
          externalUserId: true,
          providerAccountId: true,
          grantedScopes: true,
        },
      })
      if (!row) {
        sendApiError(reply, 404, 'NOT_FOUND', 'Connection not found')
        return reply
      }
      target = {
        id: row.id,
        externalUserId: row.externalUserId,
        providerAccountId: row.providerAccountId,
        grantedScopes: Array.isArray(row.grantedScopes)
          ? row.grantedScopes.filter(
              (entry): entry is string => typeof entry === 'string',
            )
          : [],
      }
    }

    const capabilities: GoogleCapabilityId[] | undefined =
      provider === 'google'
        ? (body.capabilities ?? [...DEFAULT_GOOGLE_CAPABILITIES])
        : undefined

    // Incremental authorization: ask for the union so a grant never narrows
    // what the connection already holds. `include_granted_scopes` makes Google
    // return the union regardless, and asking for it explicitly keeps the
    // consent screen honest about what the connection will end up with.
    const scopes = capabilities
      ? [...new Set([
          ...(target?.grantedScopes ?? []),
          ...scopesForCapabilities(capabilities),
        ])]
      : undefined

    const pkce = oauthConfig.usePkce ? generatePkcePair() : undefined
    const nonce = oauthConfig.useNonce ? generateOAuthNonce() : undefined
    const state = generateOAuthStateToken()
    // Resolve the public origin before minting the state row: a missing
    // api.publicUrl in a non-local deployment must fail here, not after a
    // state token bound to a wrong redirect URI has been persisted.
    let redirectUri: string
    try {
      redirectUri = buildCommsCallbackUrl(request, provider, config)
    } catch (error) {
      if (error instanceof PublicOriginConfigError) {
        sendApiError(
          reply,
          500,
          'PUBLIC_ORIGIN_NOT_CONFIGURED',
          'The server cannot determine its public origin; set '
            + 'NESSIE_API_PUBLIC_URL to the public origin of this API '
            + '(required outside local mode)',
        )
        return reply
      }
      throw error
    }

    const payload: CommsOAuthStatePayload = {
      redirectUri,
      codeVerifier: pkce?.codeVerifier ?? null,
      nonce: nonce ?? null,
      targetConnectionId: target?.id ?? null,
      expectedAccountId: target?.providerAccountId ?? null,
      ...(capabilities ? { capabilities } : {}),
    }
    await prisma.commsOAuthState.create({
      data: {
        token: state,
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
        provider,
        payload,
        expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
      },
    })

    const authorizeUrl = buildAuthorizeUrl({
      config: oauthConfig,
      clientId,
      redirectUri,
      state,
      codeChallenge: pkce?.codeChallenge,
      nonce,
      ...(scopes ? { scopes } : {}),
      // A first connect must re-prompt so Google issues a refresh token; an
      // incremental add already has one and does not need the extra screen.
      forceConsent: !target,
      // A reauthorization hint must be the persisted account, not caller
      // input. On first connect, the entered email only helps choose the right
      // provider account; callback identity proof remains authoritative.
      ...(target
        ? { loginHint: target.externalUserId }
        : body.loginHint ? { loginHint: body.loginHint } : {}),
    })
    return createApiResponse(
      CommsConnectionStartResponseSchema.parse({ authorizeUrl }),
    )
  })

  // ── GET /api/comms/connections/:provider/callback (public) ────────────────
  // Open by design and authenticated by the single-use state token, matching
  // the MCP OAuth callback: the session may have rotated during the provider
  // round-trip, so the state row (bound to user+org+provider) is the identity.
  app.get(
    '/api/comms/connections/:provider/callback',
    { config: { public: true } },
    async (request, reply) => {
      const provider = parseProviderParam(request)
      const query = request.query as {
        code?: string
        state?: string
        error?: string
      }
      if (!provider) {
        return redirectToConnections(reply, { error: 'unknown_provider' })
      }
      if (query.error) {
        return redirectToConnections(reply, {
          error: callbackQueryErrorCode(query.error),
          provider,
        })
      }
      if (!query.code || !query.state) {
        return redirectToConnections(reply, { error: 'invalid_callback', provider })
      }

      const stateRow = await prisma.commsOAuthState.findUnique({
        where: { token: query.state },
      })
      // Atomic single-use consume: only the first unexpired, unconsumed claim
      // wins, so a replayed callback cannot exchange the code twice.
      const consumed = stateRow
        ? await prisma.commsOAuthState.updateMany({
            where: {
              token: query.state,
              consumedAt: null,
              expiresAt: { gt: new Date() },
            },
            data: { consumedAt: new Date() },
          })
        : { count: 0 }
      if (!stateRow || stateRow.provider !== provider || consumed.count !== 1) {
        return redirectToConnections(reply, { error: 'state_invalid', provider })
      }

      const payload = (stateRow.payload ?? {}) as CommsOAuthStatePayload
      const redirectUri =
        payload.redirectUri
        ?? buildCommsCallbackUrl(request, provider, config)

      let connector
      try {
        connector = resolveConnector(provider)
      } catch (error) {
        if (error instanceof ConnectorNotRegisteredError) {
          return redirectToConnections(reply, {
            error: 'connector_unavailable',
            provider,
          })
        }
        throw error
      }

      try {
        const result = await connector.connect({
          organizationId: stateRow.organizationId,
          userId: stateRow.userId,
          provider,
          code: query.code,
          redirectUri,
          statePayload: payload as Record<string, unknown>,
        })

        // The flow was started to widen ONE connection. If a different Google
        // account finished consent, persisting it here would silently re-point
        // that mailbox — so refuse and let the person retry deliberately.
        if (
          payload.expectedAccountId
          && result.providerAccountId
          && result.providerAccountId !== payload.expectedAccountId
        ) {
          return redirectToConnections(reply, {
            error: 'account_mismatch',
            provider,
          })
        }

        const connectionId = await persistConnectedAccount(prisma, {
          encryptionSecret: authSecret,
          organizationId: stateRow.organizationId,
          userId: stateRow.userId,
          provider,
          connect: result,
          requestedCapabilities: payload.capabilities ?? [],
        })
        await enqueueQueueJob(prisma, {
          topic: COMMS_SYNC_INITIAL_TOPIC,
          payload: { connectionId },
        })
        await writeAuditEntry(prisma, {
          organizationId: stateRow.organizationId,
          actorType: 'user',
          actorId: stateRow.userId,
          action: 'comms.connection.created',
          resourceType: 'comms_connection',
          resourceId: connectionId,
          outcome: 'success',
          metadata: { provider },
          requestId: request.id,
        })
        return redirectToConnections(reply, { connected: provider })
      } catch (error) {
        request.log.error(
          { err: error, provider },
          'comms OAuth connect failed',
        )
        return redirectToConnections(reply, {
          error: callbackErrorCode(error),
          provider,
        })
      }
    },
  )
}
