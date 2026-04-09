import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext, AuditAction, AuditOutcome } from '@nessie/schemas'

const REDACTED_FIELDS = new Set([
  'password',
  'passwordHash',
  'secret',
  'token',
  'apiKey',
  'credential',
  'accessToken',
  'refreshToken',
  'bootstrapToken',
])

const redactMetadata = (
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!metadata) return undefined
  const redacted: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (REDACTED_FIELDS.has(key)) {
      redacted[key] = '[REDACTED]'
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      redacted[key] = redactMetadata(value as Record<string, unknown>)
    } else {
      redacted[key] = value
    }
  }
  return redacted
}

export type AuditEmitInput = {
  actorContext: AuthorizedActionContext
  action: AuditAction
  resourceType: string
  resourceId?: string
  outcome: AuditOutcome
  reason?: string
  metadata?: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
}

export const emitAuditEvent = async (
  prisma: PrismaClient,
  input: AuditEmitInput,
): Promise<void> => {
  try {
    await prisma.auditLog.create({
      data: {
        organizationId: input.actorContext.tenant.organizationId,
        projectId: input.actorContext.tenant.projectId ?? null,
        teamId: input.actorContext.tenant.teamId ?? null,
        channelId: input.actorContext.actionContext.channelId ?? null,
        actorType: input.actorContext.actor.actorType as 'user' | 'agent' | 'service' | 'system',
        actorId: input.actorContext.actor.actorId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        outcome: input.outcome,
        reason: input.reason ?? null,
        metadata: (redactMetadata(input.metadata) as Prisma.InputJsonValue) ?? undefined,
        requestId: input.actorContext.actionContext.requestId,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    })
  } catch {
    // Audit emission must never roll back the primary mutation.
    // Log the failure but do not throw.
    console.error('[audit] Failed to emit audit event:', input.action, input.resourceType)
  }
}

export type AuditLogQuery = {
  action?: string
  actorId?: string
  channelId?: string
  cursor?: string
  from?: string
  limit?: number
  organizationId: string
  outcome?: string
  projectId?: string
  resourceId?: string
  resourceType?: string
  teamId?: string
  to?: string
}

export const listAuditLogs = async (
  prisma: PrismaClient,
  query: AuditLogQuery,
) => {
  const limit = Math.min(query.limit ?? 50, 200)
  const where: Record<string, unknown> = {
    organizationId: query.organizationId,
  }

  if (query.projectId) where['projectId'] = query.projectId
  if (query.teamId) where['teamId'] = query.teamId
  if (query.channelId) where['channelId'] = query.channelId
  if (query.action) where['action'] = query.action
  if (query.actorId) where['actorId'] = query.actorId
  if (query.resourceType) where['resourceType'] = query.resourceType
  if (query.resourceId) where['resourceId'] = query.resourceId
  if (query.outcome) where['outcome'] = query.outcome

  const dateFilter: Record<string, Date> = {}
  if (query.from) dateFilter['gte'] = new Date(query.from)
  if (query.to) dateFilter['lte'] = new Date(query.to)
  if (Object.keys(dateFilter).length > 0) where['createdAt'] = dateFilter

  if (query.cursor) {
    where['id'] = { lt: query.cursor }
  }

  const entries = await prisma.auditLog.findMany({
    where: where as Prisma.AuditLogWhereInput,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
  })

  const hasMore = entries.length > limit
  const data = hasMore ? entries.slice(0, limit) : entries

  return {
    data: data.map((entry) => ({
      id: entry.id,
      organizationId: entry.organizationId,
      projectId: entry.projectId,
      teamId: entry.teamId,
      channelId: entry.channelId,
      actorType: entry.actorType,
      actorId: entry.actorId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      outcome: entry.outcome,
      reason: entry.reason,
      metadata: entry.metadata as Record<string, unknown> | null,
      requestId: entry.requestId,
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent,
      createdAt: entry.createdAt.toISOString(),
    })),
    meta: {
      cursor: hasMore && data.length > 0 ? data.at(-1)!.id : null,
      hasMore,
    },
  }
}

export const getAuditLogEntry = async (
  prisma: PrismaClient,
  entryId: string,
  organizationId: string,
) => {
  const entry = await prisma.auditLog.findFirst({
    where: { id: entryId, organizationId },
  })
  if (!entry) return null

  return {
    id: entry.id,
    organizationId: entry.organizationId,
    projectId: entry.projectId,
    teamId: entry.teamId,
    channelId: entry.channelId,
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    outcome: entry.outcome,
    reason: entry.reason,
    metadata: entry.metadata as Record<string, unknown> | null,
    requestId: entry.requestId,
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
    createdAt: entry.createdAt.toISOString(),
  }
}

export const getAuditLogSummary = async (
  prisma: PrismaClient,
  organizationId: string,
  groupBy: 'action' | 'actorId' | 'resourceType' | 'outcome',
  from?: string,
  to?: string,
) => {
  const dateFilter: string[] = []
  const params: unknown[] = [organizationId]

  if (from) {
    params.push(new Date(from))
    dateFilter.push(`AND "created_at" >= $${params.length}`)
  }
  if (to) {
    params.push(new Date(to))
    dateFilter.push(`AND "created_at" <= $${params.length}`)
  }

  const columnMap: Record<string, string> = {
    action: 'action',
    actorId: 'actor_id',
    resourceType: 'resource_type',
    outcome: 'outcome',
  }
  const column = columnMap[groupBy] ?? 'action'

  const result = await prisma.$queryRawUnsafe<Array<{ key: string; count: bigint }>>(
    `SELECT "${column}" as key, COUNT(*) as count
     FROM "audit_logs"
     WHERE "organization_id" = $1 ${dateFilter.join(' ')}
     GROUP BY "${column}"
     ORDER BY count DESC`,
    ...params,
  )

  return {
    groupBy,
    entries: result.map((row) => ({
      key: row.key,
      count: Number(row.count),
    })),
  }
}
