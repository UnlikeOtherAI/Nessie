import type { FastifyInstance } from 'fastify'
import {
  COMMS_SYNC_INCREMENTAL_TOPIC,
  COMMS_SYNC_INITIAL_TOPIC,
  CommsCapabilitiesPatchRequestSchema,
  CommsConnectionDetailSchema,
  CommsConnectionListResponseSchema,
  CommsResourcesPatchRequestSchema,
} from '@nessie/schemas'
import { resolveConnector } from '@nessie/comms-connect'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { enqueueQueueJob } from '../queue/pgqueue.js'
import type { RouteDeps } from './types.js'
import { buildConnectorContext } from './comms/context.js'
import { registerCommsOAuthRoutes } from './comms/oauth-routes.js'
import {
  serializeConnectionDetail,
  serializeConnectionSummary,
} from './comms/serialize.js'

export const registerCommsConnectionRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { prisma, requireActorContext, authSecret } = deps

  // The OAuth start/callback pair lives in its own module: it is the only part
  // of this surface that is public, state-token authenticated, and provider
  // protocol shaped.
  registerCommsOAuthRoutes(app, deps)

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

  // ── PATCH /api/comms/connections/:id/capabilities ─────────────────────────
  // Switch capabilities off locally. This is NOT a revocation at Google —
  // /revoke kills an entire grant, so there is no way to hand one scope back —
  // which is why the enforcement lives at the credential chokepoint and the UI
  // says "blocked locally" rather than "revoked".
  app.patch('/api/comms/connections/:id/capabilities', async (request, reply) => {
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
    if (connection.provider !== 'google') {
      sendApiError(
        reply,
        400,
        'VALIDATION_ERROR',
        `${connection.provider} has no capability catalog`,
      )
      return reply
    }

    const body = parseInput(
      CommsCapabilitiesPatchRequestSchema,
      request.body,
      reply,
    )
    if (!body) return reply

    const disabledCapabilities = [...new Set(body.disabledCapabilities)]
    await prisma.commsConnection.update({
      where: { id: connection.id },
      data: { disabledCapabilities },
    })
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'comms.connection.capabilities_changed',
      resourceType: 'comms_connection',
      resourceId: connection.id,
      outcome: 'success',
      metadata: { disabledCapabilities },
    })
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
