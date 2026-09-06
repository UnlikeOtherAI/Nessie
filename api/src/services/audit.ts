import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAuditEntry } from '@nessie/db'
import { isSecretKey } from '@nessie/mcp-manage'
import { buildPage, decodeKeysetCursor, resolvePageLimit, type PaginationDirection } from '@nessie/schemas'
import type { AuthorizedActionContext, AuditAction, AuditOutcome } from '@nessie/schemas'

/**
 * Keys the instance's shared "secret-shaped key" predicate does not name, but
 * the audit chain still refuses. A domain-verification challenge is published
 * in DNS, so it is not a secret in the connector sense — but it is the proof an
 * organisation controls a domain, so it never enters the audit chain.
 */
const AUDIT_ONLY_SECRET_KEYS = new Set(['challenge'])

const isAuditSecretKey = (key: string): boolean =>
  AUDIT_ONLY_SECRET_KEYS.has(key) || isSecretKey(key)

const redactValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) =>
        isAuditSecretKey(key) ? [key, '[REDACTED]'] : [key, redactValue(entryValue)],
      ),
    )
  }
  return value
}

/**
 * Audit metadata is redacted against the same key predicate as an MCP catalog
 * response, and recurses into arrays.
 *
 * It used to match a hand-listed set of exact names and skip array values
 * entirely, which made the guard on *audit output* — the one
 * `docs/architecture.md` names first — the weakest of the instance's four
 * redactors: `clientSecret`, `webhookSecret` and `apiToken` all passed it, and
 * an array of credential objects passed unexamined. Every value is replaced,
 * not just strings: a secret handed in as a nested object is still a secret.
 */
export const redactMetadata = (
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!metadata) return undefined
  return redactValue(metadata) as Record<string, unknown>
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
    await writeAuditEntry(prisma, {
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
      metadata: (redactMetadata(input.metadata) as Prisma.InputJsonValue | undefined) ?? null,
      requestId: input.actorContext.actionContext.requestId,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
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
  direction?: PaginationDirection
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
  const limit = resolvePageLimit(query.limit)
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

  // The total is counted against the same filters but before the cursor is
  // applied: "26–50 of 134" has to mean 134 matching records, not 134 records
  // after the one this page starts at.
  const total = await prisma.auditLog.count({ where: where as Prisma.AuditLogWhereInput })

  const parsed = decodeKeysetCursor(query.cursor)
  const backwards = query.direction === 'backward'
  if (parsed) {
    const existingAnd = where['AND']
    where['AND'] = [
      ...(Array.isArray(existingAnd) ? existingAnd : []),
      {
        OR: [
          { createdAt: { [backwards ? 'gt' : 'lt']: parsed.createdAt } },
          { createdAt: parsed.createdAt, id: { [backwards ? 'gt' : 'lt']: parsed.id } },
        ],
      },
    ]
  }

  const entries = await prisma.auditLog.findMany({
    where: where as Prisma.AuditLogWhereInput,
    orderBy: backwards
      ? [{ createdAt: 'asc' }, { id: 'asc' }]
      : [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  })

  const page = buildPage({
    direction: query.direction,
    hasCursor: Boolean(parsed),
    limit,
    rows: entries,
    total,
  })

  return {
    data: page.data.map((entry) => ({
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
    meta: page.meta,
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
