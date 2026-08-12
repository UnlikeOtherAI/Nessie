import type { PrismaClient } from '@prisma/client'
import { visibleUserAlertWhere } from '@nessie/db'
import { canReadSpace } from '@nessie/knowledge'
import { type AttentionDispatchJobPayload } from '@nessie/schemas'
import type { PushPayload, WebPushCredentials } from '@nessie/push'

import { shouldSuppressPushForPreferences } from './push-preferences.js'
import { defaultPushRetryDelayMs } from './push-retry.js'
import {
  deliverToRecipients,
  loadPushCredentials,
  type PushDeliveryPrisma,
  type PushDispatchSummary,
  type PushSenders,
} from './push-delivery-core.js'

export type AttentionDispatchPrisma = PushDeliveryPrisma & Pick<
  PrismaClient,
  'organizationMember' | 'projectMember' | 'userAlert'
>

export type AttentionDispatchDeps = {
  authSecret: string
  now?: () => Date
  prisma: AttentionDispatchPrisma
  retryDelayMs?: (completedAttempt: number) => number
  senders?: PushSenders
  webPush?: WebPushCredentials
}

const TERMINAL_TASK_STATUSES = new Set(['done', 'cancelled'])

type AttentionAlert = NonNullable<Awaited<ReturnType<AttentionDispatchPrisma['userAlert']['findFirst']>>>

const isActiveMember = async (
  prisma: AttentionDispatchPrisma,
  organizationId: string,
  userId: string,
): Promise<boolean> => Boolean(await prisma.organizationMember.findFirst({
  where: { organizationId, userId, deactivatedAt: null },
  select: { id: true },
}))

const resolveAttention = async (
  prisma: AttentionDispatchPrisma,
  payload: AttentionDispatchJobPayload,
): Promise<{
  alert: AttentionAlert
  body: string
  collapseId: string
  preferences: unknown
  preferenceKind: 'assignedWork' | 'publishedKnowledge'
  surface: { kind: 'project_board'; projectId: string } | { kind: 'knowledge_space'; spaceId: string }
  title: string
  url: string
} | null> => {
  const alert = await prisma.userAlert.findFirst({
    where: { id: payload.alertId, readAt: null },
    include: {
      actorUser: { select: { displayName: true } },
      knowledgePage: {
        include: {
          space: {
            include: { members: { where: { userId: { not: null } }, select: { userId: true } } },
          },
        },
      },
      task: { select: { archivedAt: true, assigneeUserId: true, id: true, status: true, title: true } },
      user: { select: { preferences: true } },
    },
  })
  if (!alert || !await isActiveMember(prisma, alert.organizationId, alert.userId)) return null

  if (alert.kind === 'task_assigned') {
    if (!alert.task || !alert.projectId || alert.task.assigneeUserId !== alert.userId
      || alert.task.archivedAt || TERMINAL_TASK_STATUSES.has(alert.task.status)) return null
    const projectMembership = await prisma.projectMember.findFirst({
      where: { projectId: alert.projectId, userId: alert.userId },
      select: { id: true },
    })
    if (!projectMembership) return null
    const assigner = alert.actorUser?.displayName ?? 'Someone'
    return {
      alert,
      body: alert.task.title ? `${assigner} assigned “${alert.task.title}” to you` : `${assigner} assigned work to you`,
      collapseId: `task:${alert.task.id}`,
      preferences: alert.user.preferences,
      preferenceKind: 'assignedWork',
      surface: { kind: 'project_board', projectId: alert.projectId },
      title: 'Work assigned to you',
      url: `/projects/${alert.projectId}/board`,
    }
  }

  if (alert.kind === 'knowledge_published') {
    const page = alert.knowledgePage
    if (!page || !alert.projectId || page.status !== 'published' || page.deletedAt || page.organizationId !== alert.organizationId) return null
    const memberUserIds = page.space.members.flatMap((member) => member.userId ? [member.userId] : [])
    const projectMembership = await prisma.projectMember.findFirst({
      where: { projectId: page.projectId, userId: alert.userId },
      select: { id: true },
    })
    const readable = canReadSpace({
      ...page.space,
      memberAgentIds: [],
      memberUserIds,
    }, {
      bypass: false,
      projectIds: projectMembership ? new Set([page.projectId]) : new Set(),
      userId: alert.userId,
    })
    if (!readable) return null
    const publisher = alert.actorUser?.displayName ?? 'Someone'
    const projectDestination = projectMembership
      ? `/projects/${page.projectId}/docs?spaceId=${page.spaceId}&pageId=${page.id}`
      : `/knowledge-base?spaceId=${page.spaceId}&pageId=${page.id}`
    return {
      alert,
      body: `${publisher} published “${page.title}”`,
      collapseId: `knowledge:${page.id}`,
      preferences: alert.user.preferences,
      preferenceKind: 'publishedKnowledge',
      surface: { kind: 'knowledge_space', spaceId: page.spaceId },
      title: 'New knowledge published',
      url: projectDestination,
    }
  }

  return null
}

export const handleAttentionDispatch = async (
  deps: AttentionDispatchDeps,
  payload: AttentionDispatchJobPayload,
): Promise<PushDispatchSummary> => {
  const summary: PushDispatchSummary = { failed: 0, pruned: 0, sent: 0 }
  const resolved = await resolveAttention(deps.prisma, payload)
  if (!resolved) return summary
  const now = deps.now?.() ?? new Date()
  if (shouldSuppressPushForPreferences(resolved.preferences, now, resolved.preferenceKind)) {
    return summary
  }

  const { apnsCreds, fcmCreds } = await loadPushCredentials(deps)
  if (!apnsCreds && !fcmCreds && !deps.webPush) return summary
  // This is the current visible project/knowledge attention subtotal. The
  // native shell folds it into the channel unread total on its next sync; do
  // not include mention-alert rows here because those are already represented
  // by the channel counter. Most importantly, reuse the same entitlement and
  // lifecycle predicate as the API so revoked/superseded rows never inflate a
  // device badge.
  const unreadAttentionCount = await deps.prisma.userAlert.count({
    where: {
      ...visibleUserAlertWhere({
        organizationId: resolved.alert.organizationId,
        userId: resolved.alert.userId,
      }),
      kind: { in: ['task_assigned', 'knowledge_published'] },
      readAt: null,
    },
  })
  const notification: PushPayload = {
    badge: unreadAttentionCount,
    body: resolved.body,
    collapseId: resolved.collapseId,
    data: { alertId: resolved.alert.id, kind: resolved.alert.kind, url: resolved.url },
    title: resolved.title,
  }
  return deliverToRecipients({
    apnsCreds,
    fcmCreds,
    ...(deps.senders ? { senders: deps.senders } : {}),
    ...(deps.webPush ? { webPush: deps.webPush } : {}),
    deepLinkUrl: resolved.url,
    messageId: null,
    now: deps.now ?? (() => new Date()),
    organizationId: resolved.alert.organizationId,
    payload: notification,
    prisma: deps.prisma,
    recipientIds: [resolved.alert.userId],
    retryDelayMs: deps.retryDelayMs ?? defaultPushRetryDelayMs,
    surface: resolved.surface,
  })
}
