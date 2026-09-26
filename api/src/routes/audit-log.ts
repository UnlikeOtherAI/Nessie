import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'

import { verifyAuditChain } from '@nessie/db'
import {
  AuditLogExportQuerySchema,
  AuditLogQuerySchema,
  AuditLogSummaryQuerySchema,
} from '@nessie/schemas'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  emitAuditEvent,
  getAuditLogEntry,
  getAuditLogSummary,
  listAuditLogs,
} from '../services/audit.js'
import { describeAuditExportFilters, streamAuditLogCsv } from '../services/audit-export.js'
import type { RouteDeps } from './types.js'

export const registerAuditLogRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireOwner } = deps

  app.get('/api/audit-log', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = parseInput(AuditLogQuerySchema, request.query ?? {}, reply, 'query')
    if (!query) return reply
    const result = await listAuditLogs(prisma, {
      organizationId: actorContext.tenant.organizationId,
      action: query.action,
      actorId: query.actorId,
      resourceType: query.resourceType,
      resourceId: query.resourceId,
      projectId: query.projectId,
      teamId: query.teamId,
      channelId: query.channelId,
      outcome: query.outcome,
      from: query.from,
      to: query.to,
      cursor: query.cursor,
      direction: query.direction === 'backward' ? 'backward' : 'forward',
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
    })

    return { data: result.data, meta: result.meta }
  })

  app.get('/api/audit-log/summary', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = parseInput(AuditLogSummaryQuerySchema, request.query ?? {}, reply, 'query')
    if (!query) return reply

    const result = await getAuditLogSummary(
      prisma,
      actorContext.tenant.organizationId,
      query.groupBy ?? 'action',
      query.from,
      query.to,
    )

    return createApiResponse(result)
  })

  // Tamper-evidence: walk the caller's organization audit hash chain and report
  // whether every entry still links to its predecessor and matches its stored
  // hash. Owner-only. Registered before /:entryId (Fastify matches static routes
  // ahead of parametric ones regardless, but keep it explicit).
  app.get('/api/audit-log/verify', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const organizationId = actorContext.tenant.organizationId
    // The walk checks only entries written since the chain existed; the ones
    // before it carry no hash and cannot be checked either way. Counting them
    // is what lets the screen say "all N verified" without that being a claim
    // about entries nobody looked at.
    const [result, unchainedCount] = await Promise.all([
      verifyAuditChain(prisma, organizationId),
      prisma.auditLog.count({ where: { entryHash: null, organizationId } }),
    ])
    return createApiResponse({ ...result, unchainedCount })
  })

  // Every entry the list's filters match, as a CSV file. Owner-only like the
  // trail itself, and recorded in it: a read of everything is worth knowing
  // who took.
  app.get('/api/audit-log/export', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = parseInput(AuditLogExportQuerySchema, request.query ?? {}, reply, 'query')
    if (!query) return reply
    const filters = {
      action: query.action,
      actorId: query.actorId,
      channelId: query.channelId,
      from: query.from,
      outcome: query.outcome,
      projectId: query.projectId,
      resourceId: query.resourceId,
      resourceType: query.resourceType,
      teamId: query.teamId,
      to: query.to,
    }
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'audit.exported',
      metadata: { filters: describeAuditExportFilters(filters) },
      outcome: 'success',
      resourceType: 'audit_log',
    })

    const day = new Date().toISOString().slice(0, 10)
    return reply
      .header('cache-control', 'no-store')
      .header('content-disposition', `attachment; filename="audit-log-${day}.csv"`)
      .type('text/csv; charset=utf-8')
      .send(Readable.from(streamAuditLogCsv(prisma, {
        ...filters,
        organizationId: actorContext.tenant.organizationId,
      })))
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
