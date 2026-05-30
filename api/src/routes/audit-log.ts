import type { FastifyInstance } from 'fastify'

import { createApiResponse, sendApiError } from '../lib/api.js'
import {
  getAuditLogEntry,
  getAuditLogSummary,
  listAuditLogs,
} from '../services/audit.js'
import type { RouteDeps } from './types.js'

export const registerAuditLogRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireOwner } = deps

  app.get('/api/audit-log', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = request.query as Record<string, string | undefined>
    const result = await listAuditLogs(prisma, {
      organizationId: actorContext.tenant.organizationId,
      action: query['action'],
      actorId: query['actorId'],
      resourceType: query['resourceType'],
      resourceId: query['resourceId'],
      projectId: query['projectId'],
      teamId: query['teamId'],
      channelId: query['channelId'],
      outcome: query['outcome'],
      from: query['from'],
      to: query['to'],
      cursor: query['cursor'],
      limit: query['limit'] ? parseInt(query['limit'], 10) : undefined,
    })

    return { data: result.data, meta: result.meta }
  })

  app.get('/api/audit-log/summary', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = request.query as Record<string, string | undefined>
    const groupBy = (query['groupBy'] ?? 'action') as 'action' | 'actorId' | 'resourceType' | 'outcome'

    const result = await getAuditLogSummary(
      prisma,
      actorContext.tenant.organizationId,
      groupBy,
      query['from'],
      query['to'],
    )

    return createApiResponse(result)
  })

  app.get('/api/audit-log/:entryId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { entryId } = request.params as { entryId: string }
    const entry = await getAuditLogEntry(prisma, entryId, actorContext.tenant.organizationId)
    if (!entry) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Audit log entry not found')
      return reply
    }

    return createApiResponse(entry)
  })
}
