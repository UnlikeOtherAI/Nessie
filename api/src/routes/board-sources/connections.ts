import type { FastifyInstance } from 'fastify'

import {
  AdapterNotRegisteredError,
  SourceCredentialRejectedError,
  listProviderMethods,
  resolveBoardSourceAdapter,
} from '@nessie/board-sources'
import {
  BoardSourceConnectionRecordSchema,
  BoardSourceProviderSchema,
  ConnectApiKeyBodySchema,
  parseUserId,
} from '@nessie/schemas'
import {
  isBoardSourceCredentialError,
  loadBoardSourceConnectionContext,
} from '@nessie/team-admin'

import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import type { RouteDeps } from '../types.js'
import { callbackPage } from './callback-page.js'
import { persistBoardSourceConnection } from './connection-persist.js'
import { consumeOAuthState, createOAuthState, createPkcePair } from './oauth-state.js'

/**
 * A person's own delegated authority at a provider — created, re-authorized and
 * removed by them, and reusable across every project they attach it to.
 *
 * Anyone may connect their own account; nothing here is administrative. What is
 * administrative is pointing a connection at a project, which lives in
 * `sources.ts`.
 */
export const registerBoardSourceConnectionRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { prisma, config, requireActorContext, requireUserActor } = deps

  const callbackUrl = (provider: string): string =>
    `${config.api.publicUrl ?? 'http://localhost:5454'}/api/board-sources/connections/${provider}/callback`

  app.get('/api/board-sources/providers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    // Every registered provider, each saying how it can be connected *here*:
    // a provider whose OAuth app is not configured still offers its API-key
    // form, and the picker renders exactly what can actually complete.
    return createApiResponse(listProviderMethods())
  })

  app.post('/api/board-sources/connections/:provider/start', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const parsed = BoardSourceProviderSchema.safeParse(
      (request.params as { provider: string }).provider,
    )
    if (!parsed.success) {
      sendApiError(reply, 404, 'PROVIDER_UNKNOWN', 'Unknown provider')
      return reply
    }
    const body = (request.body ?? {}) as { reauthorizeConnectionId?: string }

    let adapter
    try {
      adapter = resolveBoardSourceAdapter(parsed.data)
    } catch (cause) {
      if (cause instanceof AdapterNotRegisteredError) {
        sendApiError(
          reply,
          503,
          'PROVIDER_NOT_CONFIGURED',
          'This deployment has no credentials configured for that provider.',
        )
        return reply
      }
      throw cause
    }

    // A provider may be reachable by a pasted key and still have no OAuth app
    // registered here. Refusing by name beats building an authorize URL around
    // an empty client id and letting the vendor show the person the error.
    const oauth = adapter.auth.oauth
    if (!oauth) {
      sendApiError(
        reply,
        503,
        'PROVIDER_OAUTH_NOT_CONFIGURED',
        'This deployment has no sign-in app for that provider. Connect it with an API key instead.',
      )
      return reply
    }

    let expectedAccountId: string | undefined
    if (body.reauthorizeConnectionId) {
      const existing = await prisma.boardSourceConnection.findFirst({
        where: {
          id: body.reauthorizeConnectionId,
          organizationId: actorContext.tenant.organizationId,
          ownerUserId: actorContext.actor.actorId,
        },
        select: { externalAccountId: true },
      })
      if (!existing) {
        sendApiError(reply, 404, 'CONNECTION_NOT_FOUND', 'Connection not found')
        return reply
      }
      expectedAccountId = existing.externalAccountId
    }

    const pkce = createPkcePair()
    const state = await createOAuthState(prisma, {
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
      provider: parsed.data,
      payload: {
        codeVerifier: pkce.verifier,
        ...(body.reauthorizeConnectionId
          ? { targetConnectionId: body.reauthorizeConnectionId }
          : {}),
        ...(expectedAccountId ? { expectedAccountId } : {}),
      },
    })

    return createApiResponse({
      authorizeUrl: oauth.buildAuthorizeUrl({
        state,
        redirectUri: callbackUrl(parsed.data),
        codeChallenge: pkce.challenge,
      }),
    })
  })

  // Public: the provider redirects the person's browser here. Answers a
  // constant HTML page that posts the outcome to its opener — never a
  // caller-supplied return URL, which would be an open redirect with a token
  // in the query string.
  app.get('/api/board-sources/connections/:provider/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string }
    if (!query.state || (!query.code && !query.error)) {
      return reply.type('text/html').send(callbackPage(false, 'The provider sent no code.'))
    }
    const claimed = await consumeOAuthState(prisma, query.state)
    if (!claimed) {
      return reply
        .type('text/html')
        .send(callbackPage(false, 'That sign-in link has already been used.'))
    }
    if (query.error) {
      return reply.type('text/html').send(callbackPage(false, 'Authorization was declined.'))
    }

    try {
      const adapter = resolveBoardSourceAdapter(claimed.provider)
      const oauth = adapter.auth.oauth
      if (!oauth) throw new Error('no oauth method')
      const result = await oauth.exchange({
        code: query.code as string,
        redirectUri: callbackUrl(claimed.provider),
        ...(claimed.payload.codeVerifier
          ? { codeVerifier: claimed.payload.codeVerifier }
          : {}),
      })

      // A re-authorization must come back as the same account. Otherwise a
      // person could silently re-point a project's source at a different
      // Linear workspace without anybody seeing it change.
      if (
        claimed.payload.expectedAccountId &&
        claimed.payload.expectedAccountId !== result.externalAccountId
      ) {
        return reply
          .type('text/html')
          .send(callbackPage(false, 'That is a different account than the one being reconnected.'))
      }

      const connection = await persistBoardSourceConnection(prisma, {
        organizationId: claimed.organizationId,
        ownerUserId: claimed.userId,
        provider: claimed.provider,
        authMethod: 'oauth',
        result,
        encryptionSecret: config.auth.secret ?? '',
      })

      return reply.type('text/html').send(callbackPage(true, connection.id))
    } catch {
      return reply
        .type('text/html')
        .send(callbackPage(false, 'The provider refused the sign-in.'))
    }
  })

  /**
   * Trello hands its token to the *browser*, in a URL fragment the server never
   * sees. The callback page reads it and posts it here exactly once; it is
   * encrypted on arrival and never echoed back. This is the only plaintext
   * credential path in the whole feature, and it exists because Trello has no
   * authorization-code flow at all.
   */
  app.post('/api/board-sources/connections/trello/complete', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const body = (request.body ?? {}) as { state?: string; token?: string }
    if (!body.state || !body.token) {
      sendApiError(reply, 400, 'VALIDATION_ERROR', 'A state and a token are required')
      return reply
    }
    const claimed = await consumeOAuthState(prisma, body.state)
    // The state binds this submission to the authorize request that started it,
    // and to the person who made it — a token posted with somebody else's state
    // is refused.
    if (!claimed || claimed.provider !== 'trello' || claimed.userId !== actorContext.actor.actorId) {
      sendApiError(reply, 400, 'OAUTH_STATE_INVALID', 'That sign-in link has already been used.')
      return reply
    }

    try {
      const adapter = resolveBoardSourceAdapter('trello')
      // Trello has no code to exchange, so `exchange` proves the token by
      // asking Trello whose it is.
      const oauth = adapter.auth.oauth
      if (!oauth) throw new Error('no oauth method')
      const result = await oauth.exchange({ code: body.token, redirectUri: '' })
      const connection = await persistBoardSourceConnection(prisma, {
        organizationId: claimed.organizationId,
        ownerUserId: claimed.userId,
        provider: 'trello',
        authMethod: 'oauth',
        result,
        encryptionSecret: config.auth.secret ?? '',
      })
      return createApiResponse({ connectionId: connection.id })
    } catch {
      sendApiError(reply, 502, 'PROVIDER_UNREACHABLE', 'Trello did not accept that token.')
      return reply
    }
  })

  /**
   * Connect by pasting a credential the person made in their own vendor
   * account. Needs nothing registered on this deployment, which is the whole
   * point: an install with no OAuth app can still reach every provider whose
   * adapter offers a key.
   *
   * The values are proved against the provider before anything is written, and
   * the adapter — not this route — decides what the stored credential is made
   * of. Nothing here is ever echoed back: the response carries a connection id.
   */
  app.post('/api/board-sources/connections/:provider/api-key', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const parsed = BoardSourceProviderSchema.safeParse(
      (request.params as { provider: string }).provider,
    )
    if (!parsed.success) {
      sendApiError(reply, 404, 'PROVIDER_UNKNOWN', 'Unknown provider')
      return reply
    }
    const body = parseInput(ConnectApiKeyBodySchema, request.body, reply)
    if (!body) return reply

    let adapter
    try {
      adapter = resolveBoardSourceAdapter(parsed.data)
    } catch (cause) {
      if (cause instanceof AdapterNotRegisteredError) {
        sendApiError(reply, 503, 'PROVIDER_NOT_CONFIGURED', 'That provider is not configured.')
        return reply
      }
      throw cause
    }

    const apiKey = adapter.auth.apiKey
    if (!apiKey) {
      sendApiError(
        reply,
        400,
        'PROVIDER_NO_API_KEY',
        'That provider cannot be connected with a key.',
      )
      return reply
    }

    let result
    try {
      result = await apiKey.verify(body.values)
    } catch (cause) {
      // The person's own typo or wrong token kind, told back in the adapter's
      // words; anything else is the vendor being unreachable, which is not
      // theirs to fix and must not read as "your key is wrong".
      if (cause instanceof SourceCredentialRejectedError) {
        sendApiError(reply, 400, cause.code, cause.detail)
        return reply
      }
      sendApiError(reply, 502, 'PROVIDER_UNREACHABLE', 'Could not reach that provider.')
      return reply
    }

    const connection = await persistBoardSourceConnection(prisma, {
      organizationId: actorContext.tenant.organizationId,
      ownerUserId: actorContext.actor.actorId,
      provider: parsed.data,
      authMethod: 'api_key',
      result,
      encryptionSecret: config.auth.secret ?? '',
    })
    return createApiResponse({ connectionId: connection.id })
  })

  app.get('/api/board-sources/connections', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const isOwner = actorContext.actor.roles?.includes('owner') === true

    // A person sees their own connections. An organisation owner additionally
    // sees that other connections exist and whose they are — never their scopes
    // or tokens — because a source's visible authority is the point.
    const connections = await prisma.boardSourceConnection.findMany({
      where: {
        organizationId: actorContext.tenant.organizationId,
        ...(isOwner ? {} : { ownerUserId: actorContext.actor.actorId }),
      },
      include: { owner: { select: { displayName: true } } },
      orderBy: { createdAt: 'asc' },
    })

    return createApiResponse(
      BoardSourceConnectionRecordSchema.array().parse(
        connections.map((connection) => ({
          id: connection.id,
          provider: connection.provider,
          status: connection.status,
          authMethod: connection.authMethod,
          externalAccountId: connection.externalAccountId,
          externalTenantId: connection.externalTenantId,
          ownerUserId: parseUserId(connection.ownerUserId),
          ownerDisplayName: connection.owner?.displayName ?? null,
          isOwnedByViewer: connection.ownerUserId === actorContext.actor.actorId,
          lastVerifiedAt: connection.lastVerifiedAt?.toISOString() ?? null,
          createdAt: connection.createdAt.toISOString(),
        })),
      ),
    )
  })

  app.get('/api/board-sources/connections/:id/containers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { id } = request.params as { id: string }

    const connection = await prisma.boardSourceConnection.findFirst({
      where: {
        id,
        organizationId: actorContext.tenant.organizationId,
        // Listing containers calls the provider with this credential, so only
        // its owner may ask.
        ownerUserId: actorContext.actor.actorId,
      },
      select: { id: true, provider: true },
    })
    if (!connection) {
      sendApiError(reply, 404, 'CONNECTION_NOT_FOUND', 'Connection not found')
      return reply
    }

    const context = await loadBoardSourceConnectionContext(
      prisma,
      connection.id,
      config.auth.secret ?? '',
    )
    if (isBoardSourceCredentialError(context)) {
      sendApiError(
        reply,
        409,
        'CONNECTION_NEEDS_REAUTHORIZATION',
        'Reconnect this account before attaching it.',
      )
      return reply
    }

    try {
      const adapter = resolveBoardSourceAdapter(connection.provider)
      return createApiResponse(await adapter.listContainers(context))
    } catch {
      sendApiError(reply, 502, 'PROVIDER_UNREACHABLE', 'The provider could not be reached.')
      return reply
    }
  })

  app.delete('/api/board-sources/connections/:id', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { id } = request.params as { id: string }

    const connection = await prisma.boardSourceConnection.findFirst({
      where: {
        id,
        organizationId: actorContext.tenant.organizationId,
        ownerUserId: actorContext.actor.actorId,
      },
      select: { id: true, sources: { select: { project: { select: { name: true } } } } },
    })
    if (!connection) {
      sendApiError(reply, 404, 'CONNECTION_NOT_FOUND', 'Connection not found')
      return reply
    }
    if (connection.sources.length > 0) {
      // Naming the projects is the remedy: the person has to decide what should
      // happen to those boards before the credential under them disappears.
      const names = connection.sources.map((source) => source.project.name).join(', ')
      sendApiError(
        reply,
        409,
        'CONNECTION_IN_USE',
        `Still used by ${names}. Remove or re-point those sources first.`,
      )
      return reply
    }

    await prisma.boardSourceConnection.delete({ where: { id } })
    return createApiResponse({ ok: true })
  })
}
