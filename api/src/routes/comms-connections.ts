import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  COMMS_SYNC_INCREMENTAL_TOPIC,
  COMMS_SYNC_INITIAL_TOPIC,
  CommsConnectionDetailSchema,
  CommsConnectionListResponseSchema,
  CommsConnectionStartResponseSchema,
  CommsProviderSchema,
  CommsResourcesPatchRequestSchema,
  type CommsProvider,
} from '@nessie/schemas'
import {
  ConnectorNotRegisteredError,
  resolveConnector,
} from '@nessie/comms-connect'

import { writeAuditEntry } from '@nessie/db'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { enqueueQueueJob } from '../queue/pgqueue.js'
import type { RouteDeps } from './types.js'
import {
  buildAuthorizeUrl,
  buildCommsCallbackUrl,
  generateOAuthStateToken,
  generatePkcePair,
  getCommsOAuthConfig,
} from './comms/oauth-config.js'
import { buildConnectorContext } from './comms/context.js'
import { persistConnectedAccount } from './comms/persist.js'
import {
  serializeConnectionDetail,
  serializeConnectionSummary,
} from './comms/serialize.js'

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

const parseProviderParam = (request: FastifyRequest): CommsProvider | null => {
  const { provider } = request.params as { provider?: string }
  const parsed = CommsProviderSchema.safeParse(provider)
  return parsed.success ? parsed.data : null
}

export const registerCommsConnectionRoutes = (
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

  // Load a connection the caller owns (own user, own org). Returns null so the
  // route surfaces a uniform 404 — never leaking another user's connection.
  const loadOwnedConnection = (
    orgId: string,
    userId: string,
    connectionId: string,
  ) =>
    prisma.commsConnection.findFirst({
      where: { id: connectionId, organizationId: orgId, ownerUserId: userId },
    })

  const loadDetail = async (connectionId: string) => {
    const [row, resources, syncJobs] = await Promise.all([
      prisma.commsConnection.findUniqueOrThrow({ where: { id: connectionId } }),
      prisma.commsResource.findMany({
        where: { connectionId },
        orderBy: [{ resourceType: 'asc' }, { name: 'asc' }],
      }),
      prisma.commsSyncJob.findMany({
        where: { connectionId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ])
    return serializeConnectionDetail(row, resources, syncJobs)
  }

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

    const clientId = process.env[oauthConfig.clientIdEnv]
    if (!clientId) {
      sendApiError(
        reply,
        500,
        'PROVIDER_NOT_CONFIGURED',
        `${provider} OAuth client is not configured on this server`,
      )
      return reply
    }

    const pkce = oauthConfig.usePkce ? generatePkcePair() : undefined
    const state = generateOAuthStateToken()
    const redirectUri = buildCommsCallbackUrl(request, provider, config.api.publicUrl)

    await prisma.commsOAuthState.create({
      data: {
        token: state,
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
        provider,
        payload: { redirectUri, codeVerifier: pkce?.codeVerifier ?? null },
        expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
      },
    })

    const authorizeUrl = buildAuthorizeUrl({
      config: oauthConfig,
      clientId,
      redirectUri,
      state,
      codeChallenge: pkce?.codeChallenge,
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
        return redirectToConnections(reply, { error: 'access_denied', provider })
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

      const payload = (stateRow.payload ?? {}) as {
        redirectUri?: string
        codeVerifier?: string | null
      }
      const redirectUri =
        payload.redirectUri
        ?? buildCommsCallbackUrl(request, provider, config.api.publicUrl)

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
          statePayload: payload,
        })
        const connectionId = await persistConnectedAccount(prisma, {
          encryptionSecret: authSecret,
          organizationId: stateRow.organizationId,
          userId: stateRow.userId,
          provider,
          connect: result,
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
        return redirectToConnections(reply, { error: 'connect_failed', provider })
      }
    },
  )

  // ── GET /api/comms/connections ────────────────────────────────────────────
  app.get('/api/comms/connections', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const rows = await prisma.commsConnection.findMany({
      where: {
        organizationId: actorContext.tenant.organizationId,
        ownerUserId: actorContext.actor.actorId,
      },
      orderBy: { createdAt: 'desc' },
    })
    const ids = rows.map((row) => row.id)
    const [totals, synced] = ids.length
      ? await Promise.all([
          prisma.commsResource.groupBy({
            by: ['connectionId'],
            where: { connectionId: { in: ids } },
            _count: { _all: true },
          }),
          prisma.commsResource.groupBy({
            by: ['connectionId'],
            where: { connectionId: { in: ids }, syncEnabled: true },
            _count: { _all: true },
          }),
        ])
      : [[], []]
    const totalMap = new Map(totals.map((r) => [r.connectionId, r._count._all]))
    const syncedMap = new Map(synced.map((r) => [r.connectionId, r._count._all]))

    return createApiResponse(
      CommsConnectionListResponseSchema.parse({
        connections: rows.map((row) =>
          serializeConnectionSummary(row, {
            total: totalMap.get(row.id) ?? 0,
            synced: syncedMap.get(row.id) ?? 0,
          }),
        ),
      }),
    )
  })

  // ── GET /api/comms/connections/:id ────────────────────────────────────────
  app.get('/api/comms/connections/:id', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { id } = request.params as { id: string }
    const connection = await loadOwnedConnection(
      actorContext.tenant.organizationId,
      actorContext.actor.actorId,
      id,
    )
    if (!connection) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Connection not found')
      return reply
    }
    return createApiResponse(
      CommsConnectionDetailSchema.parse(await loadDetail(connection.id)),
    )
  })

  // ── PATCH /api/comms/connections/:id/resources ────────────────────────────
  app.patch('/api/comms/connections/:id/resources', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { id } = request.params as { id: string }
    const connection = await loadOwnedConnection(
      actorContext.tenant.organizationId,
      actorContext.actor.actorId,
      id,
    )
    if (!connection) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Connection not found')
      return reply
    }
    const body = parseInput(CommsResourcesPatchRequestSchema, request.body, reply)
    if (!body) return reply

    const resourceIds = body.resources.map((entry) => entry.resourceId)
    const owned = await prisma.commsResource.findMany({
      where: { id: { in: resourceIds }, connectionId: connection.id },
      select: { id: true },
    })
    if (owned.length !== new Set(resourceIds).size) {
      sendApiError(
        reply,
        400,
        'VALIDATION_ERROR',
        'One or more resources do not belong to this connection',
      )
      return reply
    }

    await prisma.$transaction(
      body.resources.map((entry) =>
        prisma.commsResource.updateMany({
          where: { id: entry.resourceId, connectionId: connection.id },
          data: { syncEnabled: entry.syncEnabled },
        }),
      ),
    )
    return createApiResponse(
      CommsConnectionDetailSchema.parse(await loadDetail(connection.id)),
    )
  })

  // ── POST /api/comms/connections/:id/resync ────────────────────────────────
  app.post('/api/comms/connections/:id/resync', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { id } = request.params as { id: string }
    const connection = await loadOwnedConnection(
      actorContext.tenant.organizationId,
      actorContext.actor.actorId,
      id,
    )
    if (!connection) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Connection not found')
      return reply
    }
    if (connection.status === 'disconnected') {
      sendApiError(reply, 409, 'CONNECTION_DISCONNECTED', 'Connection is disconnected')
      return reply
    }
    const topic = connection.initialSyncCompletedAt
      ? COMMS_SYNC_INCREMENTAL_TOPIC
      : COMMS_SYNC_INITIAL_TOPIC
    await enqueueQueueJob(prisma, { topic, payload: { connectionId: connection.id } })
    return reply.code(202).send(createApiResponse({ queued: true }))
  })

  // ── DELETE /api/comms/connections/:id (disconnect) ────────────────────────
  app.delete('/api/comms/connections/:id', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { id } = request.params as { id: string }
    const connection = await prisma.commsConnection.findFirst({
      where: {
        id,
        organizationId: actorContext.tenant.organizationId,
        ownerUserId: actorContext.actor.actorId,
      },
      include: { credential: true },
    })
    if (!connection) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Connection not found')
      return reply
    }

    // Best-effort provider revoke; never block local disconnect on it.
    if (connection.credential) {
      try {
        const connector = resolveConnector(connection.provider)
        await connector.disconnect(buildConnectorContext(connection, authSecret))
      } catch (error) {
        request.log.warn({ err: error }, 'comms provider revoke failed')
      }
    }

    await prisma.$transaction([
      prisma.commsConnectionCredential.deleteMany({
        where: { connectionId: connection.id },
      }),
      prisma.commsConnection.update({
        where: { id: connection.id },
        data: { status: 'disconnected' },
      }),
    ])
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'comms.connection.disconnected',
      resourceType: 'comms_connection',
      resourceId: connection.id,
      outcome: 'success',
      metadata: { provider: connection.provider },
    })
    return reply.code(204).send()
  })

  // ── DELETE /api/comms/connections/:id/data ────────────────────────────────
  app.delete('/api/comms/connections/:id/data', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { id } = request.params as { id: string }
    const connection = await loadOwnedConnection(
      actorContext.tenant.organizationId,
      actorContext.actor.actorId,
      id,
    )
    if (!connection) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Connection not found')
      return reply
    }

    await prisma.$transaction([
      prisma.commsEvent.deleteMany({ where: { connectionId: connection.id } }),
      prisma.commsSubscription.deleteMany({ where: { connectionId: connection.id } }),
      prisma.commsSyncJob.deleteMany({ where: { connectionId: connection.id } }),
      prisma.commsResource.deleteMany({ where: { connectionId: connection.id } }),
      prisma.commsConnection.update({
        where: { id: connection.id },
        data: { initialSyncCompletedAt: null, lastSuccessfulSyncAt: null },
      }),
    ])
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'comms.connection.data_deleted',
      resourceType: 'comms_connection',
      resourceId: connection.id,
      outcome: 'success',
      metadata: { provider: connection.provider },
    })
    return reply.code(204).send()
  })
}
