import type { PrismaClient } from '@prisma/client'
import { canReadKnowledgePageVersion, canReadSpace, loadSpaceViewer } from '@nessie/knowledge'
import { type AttentionDispatchJobPayload } from '@nessie/schemas'
import { resolveDisclosureViewer, resolveLiveEntitlements } from '@nessie/runtime'
import type { PushPayload, WebPushCredentials } from '@nessie/push'

import { shouldSuppressPushForPreferences } from './push-preferences.js'
import { loadPushBadgeCount, type PushBadgePrisma } from './push-badge.js'
import { defaultPushRetryDelayMs } from './push-retry.js'
import {
  deliverToRecipients,
  loadPushCredentials,
  type PushDeliveryPrisma,
  type PushDispatchSummary,
  type PushSenders,
} from './push-delivery-core.js'

export type AttentionDispatchPrisma = PushDeliveryPrisma & PushBadgePrisma & Pick<
  PrismaClient,
  | 'agent' | 'knowledgePageVersion' | 'organization' | 'organizationMember'
  | 'productAccountLink' | 'projectMember' | 'team' | 'userAlert'
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
  preferenceKind: 'assignedWork' | 'incomingCalls' | 'publishedKnowledge'
  surface:
    | { kind: 'channel'; channelId: string; rootMessageId: null; threadId: string }
    | { kind: 'project_board'; projectId: string }
    | { kind: 'knowledge_space'; spaceId: string }
  title: string
  url: string
} | null> => {
  const alert = await prisma.userAlert.findFirst({
    where: { id: payload.alertId, readAt: null },
    include: {
      actorUser: { select: { displayName: true } },
      call: {
        select: {
          channel: { select: { id: true, label: true } },
          id: true,
          startedBy: { select: { displayName: true } },
        },
      },
      knowledgePage: {
        include: {
          space: {
            include: { members: { where: { userId: { not: null } }, select: { userId: true } } },
          },
        },
      },
      task: {
        select: { archivedAt: true, assigneeUserId: true, id: true, projectId: true, status: true, title: true },
      },
      user: { select: { preferences: true } },
    },
  })
  if (!alert || !await isActiveMember(prisma, alert.organizationId, alert.userId)) return null

  if (alert.kind === 'task_assigned') {
    if (!alert.task || !alert.task.projectId || alert.task.assigneeUserId !== alert.userId
      || alert.task.archivedAt || TERMINAL_TASK_STATUSES.has(alert.task.status)) return null
    const projectMembership = await prisma.projectMember.findFirst({
      where: { projectId: alert.task.projectId, userId: alert.userId },
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
      surface: { kind: 'project_board', projectId: alert.task.projectId },
      title: 'Work assigned to you',
      url: `/projects/${alert.task.projectId}/board`,
    }
  }

  if (alert.kind === 'knowledge_published') {
    const page = alert.knowledgePage
    if (!page || !alert.projectId || page.status !== 'published' || page.deletedAt || page.organizationId !== alert.organizationId) return null
    // A background delivery has no request identity, so it is the one explicit
    // stored-identity revalidation path. It still calls fresh UOA `/org/me`;
    // revocation suppresses the title-bearing notification before delivery.
    const accessPrisma = prisma as unknown as PrismaClient
    const liveEntitlements = await resolveLiveEntitlements(accessPrisma, {
      allowStoredIdentity: true,
      organizationId: alert.organizationId,
      userId: alert.userId,
    })
    const [projectMembership, viewer, disclosureViewer, versions] = await Promise.all([
      prisma.projectMember.findFirst({
        where: { projectId: page.projectId, userId: alert.userId },
        select: { id: true },
      }),
      loadSpaceViewer(accessPrisma, alert.organizationId, { actorId: alert.userId, actorType: 'user' }, {
        liveEntitlements,
      }),
      resolveDisclosureViewer(accessPrisma, alert.organizationId, alert.userId, {
        allowStoredUoaIdentity: true,
        liveEntitlements,
      }),
      prisma.knowledgePageVersion.findMany({
        where: { pageId: page.id },
        select: {
          basisScopes: { select: { scopeId: true, scopeType: true } },
          disclosureSources: { select: { sourceAuthorUserId: true, sourceChannelId: true } },
        },
      }),
    ])
    const readable = canReadSpace({
      ...page.space,
      memberAgentIds: [],
      memberUserIds: page.space.members.flatMap((member) => member.userId ? [member.userId] : []),
    }, viewer)
    if (!readable || !versions.every((version) => canReadKnowledgePageVersion(version, disclosureViewer))) return null
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

  if (alert.kind === 'call_missed') {
    const call = alert.call
    if (!call || !alert.channelId || !alert.threadId) return null
    return {
      alert,
      body: `${call.startedBy.displayName} called in ${call.channel.label}`,
      collapseId: `call:${call.id}`,
      preferences: alert.user.preferences,
      preferenceKind: 'incomingCalls',
      surface: { kind: 'channel', channelId: call.channel.id, rootMessageId: null, threadId: alert.threadId },
      title: 'Missed call',
      url: `/channels/${call.channel.id}?incomingCall=${call.id}`,
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
  const badge = await loadPushBadgeCount(deps.prisma, {
    organizationId: resolved.alert.organizationId,
    userId: resolved.alert.userId,
  })
  const notification: PushPayload = {
    badge,
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
    // The durable alert row is the notification, and `attention:<alertId>` is
    // already this topic's enqueue key, so a redelivered job claims nothing new.
    notificationKey: `push:attention:${resolved.alert.id}`,
    now: deps.now ?? (() => new Date()),
    organizationId: resolved.alert.organizationId,
    payload: notification,
    prisma: deps.prisma,
    recipientIds: [resolved.alert.userId],
    retryDelayMs: deps.retryDelayMs ?? defaultPushRetryDelayMs,
    surface: resolved.surface,
  })
}
