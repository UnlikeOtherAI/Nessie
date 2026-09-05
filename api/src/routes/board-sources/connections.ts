import type { FastifyInstance } from 'fastify'

import {
  AdapterNotRegisteredError,
  listRegisteredProviders,
  resolveBoardSourceAdapter,
} from '@nessie/board-sources'
import {
  BoardSourceConnectionRecordSchema,
  BoardSourceProviderSchema,
  parseUserId,
} from '@nessie/schemas'
import {
  isBoardSourceCredentialError,
  loadBoardSourceConnectionContext,
  storeBoardSourceCredential,
} from '@nessie/team-admin'

import { createApiResponse, sendApiError } from '../../lib/api.js'
import type { RouteDeps } from '../types.js'
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
    // Only providers this deployment has credentials for: a picker that offers
    // a provider whose OAuth cannot complete is a dead end with a nice label.
    return createApiResponse(
      listRegisteredProviders().map((provider) => ({ provider })),
    )
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
      authorizeUrl: adapter.oauth.buildAuthorizeUrl({
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
      const result = await adapter.oauth.exchange({
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

      const connection = await prisma.boardSourceConnection.upsert({
        where: {
          organizationId_ownerUserId_provider_externalAccountId_externalTenantId: {
            organizationId: claimed.organizationId,
            ownerUserId: claimed.userId,
            provider: claimed.provider,
            externalAccountId: result.externalAccountId,
            externalTenantId: result.externalTenantId,
          },
        },
        create: {
          organizationId: claimed.organizationId,
          ownerUserId: claimed.userId,
          provider: claimed.provider,
          externalAccountId: result.externalAccountId,
          externalTenantId: result.externalTenantId,
          grantedScopes: result.grantedScopes,
          status: 'active',
          lastVerifiedAt: new Date(),
        },
        update: {
          grantedScopes: result.grantedScopes,
          status: 'active',
          lastVerifiedAt: new Date(),
        },
      })
      await storeBoardSourceCredential(
        prisma,
        connection.id,
        result.credential,
        config.auth.secret ?? '',
      )
      // Everything this connection runs is healthy again by construction.
      await prisma.boardSource.updateMany({
        where: { connectionId: connection.id, healthState: 'needs_reauthorization' },
        data: { healthState: 'active', healthReason: null, nextRunAt: new Date() },
      })

      return reply.type('text/html').send(callbackPage(true, connection.id))
    } catch {
      return reply
        .type('text/html')
        .send(callbackPage(false, 'The provider refused the sign-in.'))
    }
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

/**
 * The constant callback page. It posts the outcome to whatever opened it and
 * otherwise navigates back into the app — there is no caller-supplied return
 * URL anywhere in this flow.
 */
const callbackPage = (ok: boolean, detail: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>Connection</title></head>
<body style="font:14px system-ui;padding:2rem">
<p>${ok ? 'Connected. You can close this window.' : escapeHtml(detail)}</p>
<script>
  try {
    window.opener && window.opener.postMessage(
      { source: 'nessie-board-source', ok: ${ok ? 'true' : 'false'} },
      window.location.origin,
    )
  } catch (error) { /* opener gone: the page below is the fallback */ }
  if (!window.opener) window.location.replace('/settings/connections')
</script>
</body></html>`

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
