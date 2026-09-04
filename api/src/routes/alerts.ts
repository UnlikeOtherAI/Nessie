import type { FastifyInstance } from 'fastify'

import { parseChannelId, parseUserId } from '@nessie/schemas'
import {
  ListAlertsResponseSchema,
  AttentionSummarySchema,
  MarkAlertsReadBodySchema,
  MarkAlertsReadResponseSchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { getAttentionSummary, listUserAlerts, markUserAlertsRead } from '../services/alerts.js'
import type { RouteDeps } from './types.js'

// User alerts (#246): the durable alerts surface. Every read is pinned to the
// caller's organization AND user id; `alert.read` realtime events fan out per
// channel so the recipient's other devices sync read state.
export const registerAlertRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, realtimeHub, requireActorContext, buildChannelRealtimeScopes } = deps

  app.get('/api/alerts', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const query = request.query as Record<string, string | undefined>
    let limit: number | undefined
    if (query.limit !== undefined) {
      const parsed = Number.parseInt(query.limit, 10)
      if (!Number.isFinite(parsed) || parsed < 1) {
        sendApiError(reply, 400, 'VALIDATION_ERROR', 'limit must be a positive integer', 'limit')
        return reply
      }
      limit = parsed
    }

    const result = await listUserAlerts(prisma, {
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
      cursor: query.cursor,
      direction: query.direction === 'backward' ? 'backward' : 'forward',
      limit,
      unreadOnly: query.unread === 'true' || query.unread === '1',
    })

    return createApiResponse(ListAlertsResponseSchema.parse(result.data), result.meta)
  })

  app.get('/api/alerts/summary', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const summary = await getAttentionSummary(prisma, {
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    return createApiResponse(AttentionSummarySchema.parse(summary))
  })

  app.post('/api/alerts/read', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(MarkAlertsReadBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const organizationId = actorContext.tenant.organizationId
    const userId = actorContext.actor.actorId
    const result = await markUserAlertsRead(prisma, {
      organizationId,
      userId,
      ids: body.ids,
      all: body.all,
      surface: body.surface
        ? {
            kind: body.surface.kind,
            projectId: body.surface.projectId,
          }
        : undefined,
    })

    // Cross-device read-state sync: one alert.read event per affected channel,
    // best-effort — the read itself is already durable.
    const alertIdsByChannel = new Map<string, string[]>()
    for (const alert of result.readAlerts) {
      if (!alert.channelId) continue
      const ids = alertIdsByChannel.get(alert.channelId) ?? []
      ids.push(alert.id)
      alertIdsByChannel.set(alert.channelId, ids)
    }
    for (const [channelId, alertIds] of alertIdsByChannel) {
      try {
        await realtimeHub.publishWs(
          buildChannelRealtimeScopes({ channelId, organizationId }),
          {
            data: {
              userId: parseUserId(userId),
              alertIds,
              channelId: parseChannelId(channelId),
              readAt: result.readAt.toISOString(),
            },
            event: 'alert.read',
          },
        )
      } catch (error) {
        app.log.error({ err: error, channelId }, '[alerts] failed to publish alert.read')
      }
    }

    return createApiResponse(
      MarkAlertsReadResponseSchema.parse({
        read: result.read,
        unreadCount: result.unreadCount,
      }),
    )
  })
}
