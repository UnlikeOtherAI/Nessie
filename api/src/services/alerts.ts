import { createHash } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import { visibleUserAlertWhere } from '@nessie/db'
import {
  buildPage,
  decodeKeysetCursor,
  resolvePageLimit,
  type PaginationDirection,
  type PaginationMeta,
} from '@nessie/schemas'

import { TeamInvitationAlertMetadataSchema, type UserAlertRecord } from '../contracts/alerts.js'
import { withBudgetScopeNames } from './budget-scope-names.js'

// User alerts (#246): org-scoped, per-user reads of the durable UserAlert
// store. Every query is pinned to BOTH the caller's organization and the
// caller's user id — alerts are private to their recipient.

const alertInclude = {
  message: { select: { id: true, rootMessageId: true } },
  channel: { select: { label: true } },
  actorUser: { select: { displayName: true } },
  actorAgent: { select: { name: true } },
  automaticMembershipRule: { select: { team: { select: { name: true } } } },
  trigger: { select: { name: true } },
  budgetAlert: {
    select: { kind: true, percentUsed: true, period: true, scopeId: true, scopeType: true },
  },
} satisfies Prisma.UserAlertInclude

type AlertWithRelations = Prisma.UserAlertGetPayload<{ include: typeof alertInclude }>

const alertMetadata = (
  alert: AlertWithRelations,
): UserAlertRecord['metadata'] => {
  if (alert.kind !== 'team_invitation') return null
  const parsed = TeamInvitationAlertMetadataSchema.safeParse(alert.metadata)
  return parsed.success ? parsed.data : null
}

type BudgetScopeNames = Map<string, string | null>

const budgetScopeKey = (scope: { scopeType: string; scopeId: string }): string =>
  `${scope.scopeType}:${scope.scopeId}`

// What a budget_alert row says, read from the marker it points at. The marker's
// kind is a plain column; anything but the two kinds the writer uses reads as
// no summary rather than a guess.
const budgetAlertSummary = (
  alert: AlertWithRelations,
  names: BudgetScopeNames,
): UserAlertRecord['budgetAlert'] => {
  const marker = alert.budgetAlert
  if (alert.kind !== 'budget_alert' || !marker) return null
  if (marker.kind !== 'threshold' && marker.kind !== 'blocked') return null
  return {
    kind: marker.kind,
    percentUsed: marker.percentUsed,
    period: marker.period,
    scopeName: names.get(budgetScopeKey(marker)) ?? null,
    scopeType: marker.scopeType,
  }
}

/** The names of the budgets a page of alerts reports, read once per page. */
const budgetScopeNamesFor = async (
  prisma: PrismaClient,
  organizationId: string,
  alerts: readonly AlertWithRelations[],
): Promise<BudgetScopeNames> => {
  const scopes = alerts.flatMap((alert) => (alert.budgetAlert ? [alert.budgetAlert] : []))
  if (scopes.length === 0) return new Map()
  const named = await withBudgetScopeNames(prisma, organizationId, scopes)
  return new Map(named.map((scope) => [budgetScopeKey(scope), scope.scopeName]))
}

const mapAlertRecord = (alert: AlertWithRelations, budgetScopeNames: BudgetScopeNames): UserAlertRecord => ({
  id: alert.id,
  kind: alert.kind,
  messageId: alert.messageId,
  rootMessageId: alert.message ? alert.message.rootMessageId ?? alert.message.id : null,
  threadId: alert.threadId,
  channelId: alert.channelId,
  channelLabel: alert.channel?.label ?? null,
  projectId: alert.projectId ?? null,
  taskId: alert.taskId ?? null,
  taskSetId: alert.taskSetId ?? null,
  knowledgePageId: alert.knowledgePageId ?? null,
  triggerId: alert.triggerId ?? null,
  // Named only where the line names it; the other trigger kind stays generic.
  ...(alert.kind === 'trigger_machine_access' ? { triggerName: alert.trigger?.name ?? null } : {}),
  automaticMembershipRuleId: alert.automaticMembershipRuleId ?? null,
  automaticMembershipRuleTeamName: alert.automaticMembershipRule?.team.name ?? null,
  boardSourceId: alert.boardSourceId ?? null,
  workflowRunId: alert.workflowRunId ?? null,
  callId: alert.callId ?? null,
  localInferenceHostId: alert.localInferenceHostId ?? null,
  localInferenceBindingId: alert.localInferenceBindingId ?? null,
  ...(alert.kind === 'budget_alert' ? { budgetAlert: budgetAlertSummary(alert, budgetScopeNames) } : {}),
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
    direction?: PaginationDirection
    limit?: number
    unreadOnly?: boolean
  },
): Promise<{
  // The paged-list contract: `data` IS the page of records and `meta` carries
  // the cursors and the total (docs/standards/design-system.md → "a big
  // element is one contract from the API to the pixel"). The unread count is
  // its own fact and is served by
  // `GET /api/alerts/summary`; returning it inside the page made this endpoint
  // the one list `usePagedList` could not read.
  data: UserAlertRecord[]
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
  const total = await prisma.userAlert.count({ where: { AND: conditions } })

  const parsed = decodeKeysetCursor(input.cursor)
  const backwards = input.direction === 'backward'
  if (parsed) {
    conditions.push({ OR: [
      { createdAt: { [backwards ? 'gt' : 'lt']: parsed.createdAt } },
      { createdAt: parsed.createdAt, id: { [backwards ? 'gt' : 'lt']: parsed.id } },
    ] })
  }

  const rows = await prisma.userAlert.findMany({
    where: { AND: conditions },
    orderBy: backwards
      ? [{ createdAt: 'asc' }, { id: 'asc' }]
      : [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    include: alertInclude,
  })

  const page = buildPage({
    direction: input.direction,
    hasCursor: Boolean(parsed),
    limit,
    rows,
    total,
  })

  const budgetScopeNames = await budgetScopeNamesFor(prisma, input.organizationId, page.data)
  return {
    data: page.data.map((alert) => mapAlertRecord(alert, budgetScopeNames)),
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
