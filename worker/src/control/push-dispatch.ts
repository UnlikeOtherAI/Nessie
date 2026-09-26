import type { PrismaClient } from '@prisma/client'
import {
  canUserReadDisclosureBasis,
  isOpenMentionChannel,
  resolveLiveEntitlementDecision,
  type BasisScopeRow,
} from '@nessie/runtime'
import { buildChannelMessagePath, type PushDispatchJobPayload } from '@nessie/schemas'
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

/**
 * Worker consumer for the `push.dispatch` queue topic. Resolves the recipients
 * of a freshly-posted message (channel members minus the author, or the explicit
 * recipient of an interactive agent reply), then hands the built payload +
 * recipient set to the shared {@link deliverToRecipients} core, which loads
 * credentials and fans out over native APNs/FCM + browser Web Push.
 *
 * The senders, prisma client, and auth secret are injected (see
 * {@link PushDispatchDeps}) so the handler is fully unit-testable without any
 * network or live database.
 *
 * **A redelivered job re-rings no endpoint whose claim already reads `sent`.**
 * The API enqueues with the idempotency key `push:<messageId>`, so two enqueues
 * for one message collapse to one job row; this handler then passes
 * `push:message:<messageId>` as the delivery core's `notificationKey`, and the
 * core claims a `push_send_claims` row per endpoint before it calls a provider.
 * A job that is redelivered — a dropped ack during a drain, a lock expiry, a
 * nack-and-retry — loses those claims. What that does and does not cover is
 * stated once in `./push-send-claim.ts`; this handler adds nothing to it.
 */

export type { PushDispatchSummary, PushSenders } from './push-delivery-core.js'

/** Minimal Prisma surface the dispatch handler touches — keeps tests light. */
export type PushDispatchPrisma = PushDeliveryPrisma &
  PushBadgePrisma &
  Pick<PrismaClient,
    | 'agent'
    | 'announcementDelivery'
    | 'channelMember'
    | 'channel'
    | 'disclosureGrant'
    | 'message'
    | 'organizationMember'
    | 'organization'
    | 'productAccountLink'
    | 'projectMember'
    | 'scopeDisclosureGrant'
    | 'teamMember'
    | 'team'
    | 'user'>

export type PushDispatchDeps = {
  prisma: PushDispatchPrisma
  /** Independently rotated key ring for stored APNs/FCM credentials. */
  encryptionKeyRing: import('@nessie/runtime').EncryptionKeyRingInput
  /**
   * VAPID credentials for browser Web Push, populated only when all three
   * config values are present. When set, recipients' browser subscriptions are
   * delivered to in addition to native APNs/FCM tokens.
   */
  webPush?: WebPushCredentials
  /** Push senders, injected so tests can stub them (default: real network). */
  senders?: PushSenders
  /** Clock injection keeps recipient preference filtering deterministic in tests. */
  now?: () => Date
  /** Retry backoff injection; tests pass zero to stay fast. */
  retryDelayMs?: (completedAttempt: number) => number
}

type PushMessage = {
  isAnnouncement: boolean
  agentId: string | null
  agent: { name: string } | null
  basisScopes: BasisScopeRow[]
  disclosureSources: Array<{ sourceAuthorUserId: string | null; sourceChannelId: string }>
  user: { displayName: string } | null
}

const genericReplyBody = 'An agent reply is ready.'

export const handlePushDispatch = async (
  deps: PushDispatchDeps,
  payload: PushDispatchJobPayload,
): Promise<PushDispatchSummary> => {
  const summary: PushDispatchSummary = { sent: 0, failed: 0, pruned: 0 }
  const retryDelayMs = deps.retryDelayMs ?? defaultPushRetryDelayMs
  const webPushEnabled = Boolean(deps.webPush)

  // 1. Load native credentials. Nothing to do when no native provider AND no
  // web push is configured.
  const { apnsCreds, fcmCreds } = await loadPushCredentials(deps)
  if (!apnsCreds && !fcmCreds && !webPushEnabled) {
    return summary
  }

  // 2. Resolve recipients: active organization members of the channel minus
  // the author, or the structurally-selected requester of an agent reply. In
  // both cases, muted members, disabled push preferences, and users currently
  // inside quiet hours are excluded. Channel rows are retained when somebody is
  // deactivated, so membership alone must never be treated as current access.
  const recipientUserIds = payload.recipientUserIds
  const members = await deps.prisma.channelMember.findMany({
    where: {
      channelId: payload.channelId,
      userId: recipientUserIds
        ? { in: recipientUserIds }
        : { not: payload.authorUserId },
      user: {
        organizationMembers: {
          some: { deactivatedAt: null, organizationId: payload.organizationId },
        },
      },
    },
    select: { muted: true, userId: true },
  })
  const channel = await deps.prisma.channel.findUnique({
    where: { id: payload.channelId },
    select: { label: true, systemChannelType: true, type: true, visibility: true,
      teamId: true, project: { select: { channelRoot: true } },
    },
  })
  const announcementMessage = await deps.prisma.message.findUnique({
    where: { id: payload.messageId }, select: { isAnnouncement: true },
  })
  const announcementRecipientIds = new Set<string>()
  if (announcementMessage?.isAnnouncement && channel) {
    const deliveries = await deps.prisma.announcementDelivery.findMany({
      where: { messageId: payload.messageId },
      select: { recipientUserId: true, recipientUoaSub: true },
    })
    const subjects = deliveries.flatMap((delivery) =>
      delivery.recipientUoaSub ? [delivery.recipientUoaSub] : [],
    )
    const subjectUsers = subjects.length > 0 ? await deps.prisma.user.findMany({
      where: { uoaSub: { in: subjects } }, select: { id: true, uoaSub: true },
    }) : []
    const userBySubject = new Map(subjectUsers.flatMap((user) =>
      user.uoaSub ? [[user.uoaSub, user.id] as const] : [],
    ))
    for (const delivery of deliveries) {
      const userId = delivery.recipientUserId
        ?? (delivery.recipientUoaSub ? userBySubject.get(delivery.recipientUoaSub) : undefined)
      if (!userId) continue
      const decision = await resolveLiveEntitlementDecision(deps.prisma, {
        allowStoredIdentity: true, organizationId: payload.organizationId, userId,
      })
      if (decision.status === 'unavailable') throw new Error('UOA unavailable for announcement push')
      if (decision.status !== 'allowed') continue
      const currentMember = channel.project.channelRoot
        ? true
        : decision.entitlements.kind === 'uoa'
          ? decision.entitlements.teamIds.includes(channel.teamId)
          : (await deps.prisma.teamMember.count({
            where: { teamId: channel.teamId, userId },
          })) > 0
      if (currentMember) announcementRecipientIds.add(userId)
    }
  }
  // An open channel (public, not a DM, not a system conversation) is readable
  // by every active organisation member, so a person @mentioned there who never
  // joined is still rung — framed as a mention. A private or protected channel
  // never adds anyone: its recipients are its members, and the API never lists
  // a non-member in `mentionUserIds` there. An explicitly addressed message (a
  // DeepWater result naming its requester) follows the same rule, and never
  // rings anyone it does not address.
  const memberIds = new Set(members.map((member) => member.userId))
  const addressed = (userId: string): boolean => !recipientUserIds || recipientUserIds.includes(userId)
  const openChannelMentionCandidates = payload.mentionUserIds.filter(
    (userId) => userId !== payload.authorUserId && !memberIds.has(userId) && addressed(userId),
  )
  const openChannelMentionIds = openChannelMentionCandidates.length > 0 && channel && isOpenMentionChannel({
    ...channel,
    organizationId: payload.organizationId,
  })
    ? (await deps.prisma.organizationMember.findMany({
      where: {
        deactivatedAt: null,
        organizationId: payload.organizationId,
        userId: { in: openChannelMentionCandidates },
      },
      select: { userId: true },
    })).map((row) => row.userId)
    : []
  const unmutedRecipientIds = [
    ...members.filter((member) => !member.muted && (
      !announcementMessage?.isAnnouncement || payload.mentionUserIds.includes(member.userId)
    )).map((member) => member.userId),
    ...openChannelMentionIds,
    ...announcementRecipientIds,
  ]
  if (unmutedRecipientIds.length === 0) {
    return summary
  }

  const users = await deps.prisma.user.findMany({
    where: { id: { in: [...new Set(unmutedRecipientIds)] } },
    select: { id: true, preferences: true },
  })
  // A protected reply never contains content in a notification. Its requester
  // receives a generic completion only if they still pass the exact same
  // basis + grant predicate that gates the conversation feed at this moment.
  // That makes membership and grant revocation effective before a queued push
  // can reach a lock screen.
  const protectedReply = payload.contentVisibility === 'generic'
  // Resolve the durable author, not an enqueue-time label. Agent replies do
  // not have a user author, while ordinary messages may have either source.
  // This gives every platform the familiar sender + destination presentation.
  const replyMessage: PushMessage | null = await deps.prisma.message.findUnique({
    where: { id: payload.messageId },
    select: {
      agentId: true,
      isAnnouncement: true,
      agent: { select: { name: true } },
      basisScopes: { select: { scopeId: true, scopeType: true } },
      disclosureSources: { select: { sourceAuthorUserId: true, sourceChannelId: true } },
      user: { select: { displayName: true } },
    },
  })
  if (protectedReply && !replyMessage) {
    return summary
  }
  const entitledUsers = protectedReply && replyMessage
    ? (await Promise.all(users.map(async (user) => ({
      user,
      readable: await canUserReadDisclosureBasis(deps.prisma, {
        agentId: replyMessage.agentId,
        allowStoredUoaIdentity: true,
        basis: replyMessage.basisScopes,
        channelId: payload.channelId,
        disclosureSources: replyMessage.disclosureSources,
        messageId: payload.messageId,
        organizationId: payload.organizationId,
        userId: user.id,
      }),
    })))).filter((entry) => entry.readable).map((entry) => entry.user)
    : users
  if (entitledUsers.length === 0) {
    return summary
  }
  const now = deps.now?.() ?? new Date()
  // 3. Build sender-first notification payloads (deep-link data + per-channel
  // coalescing). APNs shows the channel as its subtitle; FCM/Web Push preserve
  // it by composing that subtitle into their one available title line. Muted
  // members were filtered out above for everyone — a muted channel suppresses
  // even mention pushes, but the durable UserAlert row + bell badge are still
  // created API-side, so a mention is never lost, just quiet.
  const channelLabel = channel?.label ?? 'New message'
  const authorName = payload.authorName
    ?? replyMessage?.agent?.name
    ?? replyMessage?.user?.displayName
    ?? 'Nessie'
  // A mention keeps its framing — and its preference class — when its content
  // is withheld: the framing says who it is for, never what it says, and the
  // recipient set above already holds only people the message addresses.
  const mentionUserIds = new Set(payload.mentionUserIds)
  const mentionedRecipientIds = entitledUsers
    .filter((user) => !announcementRecipientIds.has(user.id))
    .filter((user) => mentionUserIds.has(user.id))
    .filter((user) => !shouldSuppressPushForPreferences(user.preferences, now, 'mentions'))
    .map((user) => user.id)
  const otherRecipientIds = entitledUsers
    .filter((user) => !announcementRecipientIds.has(user.id))
    .filter((user) => !mentionUserIds.has(user.id))
    .filter((user) => !shouldSuppressPushForPreferences(user.preferences, now, 'messages'))
    .map((user) => user.id)
  const mandatoryRecipientIds = entitledUsers
    .filter((user) => announcementRecipientIds.has(user.id))
    .filter((user) => !shouldSuppressPushForPreferences(user.preferences, now, 'announcements'))
    .map((user) => user.id)

  // A reply panel is the actionable destination for both a top-level message
  // and a reply. Older queued jobs simply use their message as the root.
  const deepLinkUrl = replyMessage?.isAnnouncement && !payload.rootMessageId
    ? `/channels/${payload.channelId}/threads/${payload.threadId}/replies/${payload.messageId}`
    : buildChannelMessagePath(payload)

  const buildPayload = (subtitle: string, badge: number): PushPayload => ({
    badge,
    title: authorName,
    subtitle,
    body: protectedReply
      ? payload.genericBody ?? genericReplyBody
      : payload.contentSnippet.replace(/\s+/gu, ' ').trim() || 'New message',
    data: {
      channelId: payload.channelId,
      threadId: payload.threadId,
      messageId: payload.messageId,
      ...(payload.rootMessageId ? { rootMessageId: payload.rootMessageId } : {}),
      url: deepLinkUrl,
    },
    // Keep distinct reply conversations visible independently while retaining
    // familiar per-channel coalescing for the main feed.
    collapseId: payload.rootMessageId ?? payload.threadId,
  })

  // 4. Deliver over native + Web Push through the shared core. The framing is
  // grouped, but each recipient gets their own current icon total.
  const deliver = async (ids: string[], subtitle: string): Promise<PushDispatchSummary> => {
    const results = await Promise.all(ids.map(async (userId) => {
      const badge = await loadPushBadgeCount(deps.prisma, {
        organizationId: payload.organizationId,
        userId,
      })
      return deliverToRecipients({
        prisma: deps.prisma,
        apnsCreds,
        fcmCreds,
        ...(deps.webPush ? { webPush: deps.webPush } : {}),
        ...(deps.senders ? { senders: deps.senders } : {}),
        retryDelayMs,
        payload: buildPayload(subtitle, badge),
        recipientIds: [userId],
        organizationId: payload.organizationId,
        deepLinkUrl,
        messageId: payload.messageId,
        // The message IS the notification, and `push:message:<id>` is what the
        // API's enqueue keys on, so a redelivered job re-derives the same claim
        // key and every device it already rang is skipped. Both fan-out groups
        // (mentioned / not) share it safely: a recipient is in exactly one, so
        // no endpoint is ever reached by both.
        notificationKey: `push:message:${payload.messageId}`,
        surface: {
          channelId: payload.channelId,
          kind: 'channel',
          rootMessageId: payload.rootMessageId ?? null,
          threadId: payload.threadId,
        },
        now: deps.now ?? (() => new Date()),
      })
    }))
    return results.reduce<PushDispatchSummary>((combined, result) => ({
      failed: combined.failed + result.failed,
      pruned: combined.pruned + result.pruned,
      sent: combined.sent + result.sent,
    }), { sent: 0, failed: 0, pruned: 0 })
  }

  if (otherRecipientIds.length > 0) {
    const delivered = await deliver(otherRecipientIds, `# ${channelLabel}`)
    summary.sent += delivered.sent
    summary.failed += delivered.failed
    summary.pruned += delivered.pruned
  }
  if (mandatoryRecipientIds.length > 0) {
    const delivered = await deliver(mandatoryRecipientIds, `# ${channelLabel}`)
    summary.sent += delivered.sent
    summary.failed += delivered.failed
    summary.pruned += delivered.pruned
  }

  if (mentionedRecipientIds.length > 0) {
    const delivered = await deliver(mentionedRecipientIds, `mentioned you in # ${channelLabel}`)
    summary.sent += delivered.sent
    summary.failed += delivered.failed
    summary.pruned += delivered.pruned
  }

  console.log('[push-dispatch] done', {
    messageId: payload.messageId,
    channelId: payload.channelId,
    recipients: otherRecipientIds.length + mentionedRecipientIds.length,
    mentioned: mentionedRecipientIds.length,
    sent: summary.sent,
    failed: summary.failed,
    pruned: summary.pruned,
  })

  return summary
}
