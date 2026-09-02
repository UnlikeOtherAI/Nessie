import { createHash } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import { visibleUserAlertWhere } from '@nessie/db'
import { buildPage, decodeKeysetCursor, resolvePageLimit, type PaginationMeta } from '@nessie/schemas'

import {
  WorkspaceInvitationAlertMetadataSchema,
  type UserAlertRecord,
} from '../contracts.js'

// User alerts (#246): org-scoped, per-user reads of the durable UserAlert
// store. Every query is pinned to BOTH the caller's organization and the
// caller's user id — alerts are private to their recipient.

const alertInclude = {
  message: { select: { id: true, rootMessageId: true } },
  channel: { select: { label: true } },
  actorUser: { select: { displayName: true } },
  actorAgent: { select: { name: true } },
} satisfies Prisma.UserAlertInclude

type AlertWithRelations = Prisma.UserAlertGetPayload<{ include: typeof alertInclude }>

const alertMetadata = (
  alert: AlertWithRelations,
): UserAlertRecord['metadata'] => {
  if (alert.kind !== 'workspace_invitation') return null
  const parsed = WorkspaceInvitationAlertMetadataSchema.safeParse(alert.metadata)
  return parsed.success ? parsed.data : null
}

const mapAlertRecord = (alert: AlertWithRelations): UserAlertRecord => ({
  id: alert.id,
  kind: alert.kind,
  messageId: alert.messageId,
  rootMessageId: alert.message ? alert.message.rootMessageId ?? alert.message.id : null,
  threadId: alert.threadId,
  channelId: alert.channelId,
  channelLabel: alert.channel?.label ?? null,
  projectId: alert.projectId ?? null,
  taskId: alert.taskId ?? null,
  knowledgePageId: alert.knowledgePageId ?? null,
  triggerId: alert.triggerId ?? null,
  callId: alert.callId ?? null,
  metadata: alertMetadata(alert),
  actorUserId: alert.actorUserId,
  actorAgentId: alert.actorAgentId,
  actorDisplayName: alert.actorUser?.displayName ?? alert.actorAgent?.name ?? null,
  readAt: alert.readAt ? alert.readAt.toISOString() : null,
  createdAt: alert.createdAt.toISOString(),
})

const unreadCount = (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string },
): Promise<number> =>
  prisma.userAlert.count({ where: { ...visibleUserAlertWhere(input), readAt: null } })

export const listUserAlerts = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    userId: string
    cursor?: string
    limit?: number
    unreadOnly?: boolean
  },
): Promise<{
  data: { alerts: UserAlertRecord[]; unreadCount: number }
  meta: PaginationMeta
}> => {
  const limit = resolvePageLimit(input.limit)
  const conditions: Prisma.UserAlertWhereInput[] = [
    visibleUserAlertWhere(input),
    ...(input.unreadOnly ? [{ readAt: null }] : []),
  ]

  // The total is counted against the same filters but before the cursor is
  // applied: "26–50 of 134" has to mean 134 matching records, not 134 records
  // after the one this page starts at.
  const [total, unread] = await Promise.all([
    prisma.userAlert.count({ where: { AND: conditions } }),
    unreadCount(prisma, input),
  ])

  const parsed = decodeKeysetCursor(input.cursor)
  if (parsed) {
    conditions.push({ OR: [
      { createdAt: { lt: parsed.createdAt } },
      { createdAt: parsed.createdAt, id: { lt: parsed.id } },
    ] })
  }

  const rows = await prisma.userAlert.findMany({
    where: { AND: conditions },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    include: alertInclude,
  })

  const page = buildPage({
    hasCursor: Boolean(parsed),
    limit,
    rows,
    total,
  })

  return {
    data: { alerts: page.data.map(mapAlertRecord), unreadCount: unread },
    meta: page.meta,
  }
}

export type MarkUserAlertsReadResult = {
  read: number
  unreadCount: number
  readAt: Date
  // Channel ids that had alerts marked read. Existing channel-scoped realtime
  // frames can synchronize these safely; private attention kinds reconcile by
  // their short client refresh instead of being exposed to another channel.
  readAlerts: { id: string; channelId: string | null }[]
}

type AttentionSummarySection = {
  projects: Record<string, number>
  total: number
  versions: Record<string, string>
}

type AttentionSummaryAccumulator = AttentionSummarySection & {
  alertIds: Record<string, string[]>
}

const attentionVersion = (alertIds: string[]): string =>
  createHash('sha256').update(alertIds.sort().join(',')).digest('base64url')

const finalizeAttentionSummary = (
  section: AttentionSummaryAccumulator,
): AttentionSummarySection => {
  for (const [projectId, alertIds] of Object.entries(section.alertIds)) {
    section.versions[projectId] = attentionVersion(alertIds)
  }
  return { projects: section.projects, total: section.total, versions: section.versions }
}

export const getAttentionSummary = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string },
): Promise<{
  assignedWork: AttentionSummarySection
  knowledge: AttentionSummarySection
  unreadCount: number
}> => {
  const rows = await prisma.userAlert.findMany({
    where: {
      ...visibleUserAlertWhere(input),
      readAt: null,
      kind: { in: ['task_assigned', 'knowledge_published'] },
    },
    select: { id: true, kind: true, projectId: true },
  })
  const assignedWork: AttentionSummaryAccumulator = {
    projects: {}, total: 0, versions: {}, alertIds: {},
  }
  const knowledge: AttentionSummaryAccumulator = {
    projects: {}, total: 0, versions: {}, alertIds: {},
  }
  for (const row of rows) {
    const category = row.kind === 'task_assigned' ? assignedWork : knowledge
    category.total += 1
    if (!row.projectId) continue
    category.projects[row.projectId] = (category.projects[row.projectId] ?? 0) + 1
    const alertIds = category.alertIds[row.projectId] ?? []
    alertIds.push(row.id)
    category.alertIds[row.projectId] = alertIds
  }
  return {
    assignedWork: finalizeAttentionSummary(assignedWork),
    knowledge: finalizeAttentionSummary(knowledge),
    unreadCount: await unreadCount(prisma, input),
  }
}

export const markUserAlertsRead = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    userId: string
    ids?: string[]
    all?: boolean
    surface?: {
      kind: 'task_assigned' | 'knowledge_published'
      projectId: string
    }
  },
): Promise<MarkUserAlertsReadResult> => {
  const surfaceWhere: Prisma.UserAlertWhereInput | null = input.surface
    ? {
        kind: input.surface.kind,
        projectId: input.surface.projectId,
      }
    : null
  const where: Prisma.UserAlertWhereInput = {
    AND: [
      visibleUserAlertWhere(input),
      { readAt: null },
      ...(surfaceWhere ? [surfaceWhere] : input.all ? [] : [{ id: { in: input.ids ?? [] } }]),
    ],
  }

  // Read the affected rows first so the route can publish per-channel
  // `alert.read` realtime events; updateMany returns only a count. For a
  // project surface this is also the server-side snapshot: the exact IDs are
  // repeated below, so an alert committed after this select cannot be cleared.
  const readAlerts = await prisma.userAlert.findMany({
    where,
    select: { id: true, channelId: true },
  })
  const readAt = new Date()
  let read = 0
  if (readAlerts.length > 0) {
    const updated = await prisma.userAlert.updateMany({
      // Repeat the complete authorization/lifecycle predicate at mutation
      // time. A task reassignment or access revocation between the selection
      // and this write must not let a stale screen alter an unrelated row.
      where: {
        AND: [
          where,
          { id: { in: readAlerts.map((alert) => alert.id) } },
        ],
      },
      data: { readAt },
    })
    read = updated.count
  }

  return {
    read,
    unreadCount: await unreadCount(prisma, input),
    readAt,
    readAlerts,
  }
}
