import type { PrismaClient } from '@prisma/client'
import { canUserReadDisclosureBasis, type BasisScopeRow } from '@nessie/runtime'
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
    | 'channelMember'
    | 'channel'
    | 'disclosureGrant'
    | 'message'
    | 'organizationMember'
    | 'projectMember'
    | 'scopeDisclosureGrant'
    | 'teamMember'
    | 'user'>

export type PushDispatchDeps = {
  prisma: PushDispatchPrisma
  /** Deployment auth secret — the key the secret store encrypted creds under. */
  authSecret: string
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
  agentId: string | null
  agent: { name: string } | null
  basisScopes: BasisScopeRow[]
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
  const unmutedRecipientIds = members
    .filter((member) => !member.muted)
    .map((member) => member.userId)
  if (unmutedRecipientIds.length === 0) {
    return summary
  }

  const users = await deps.prisma.user.findMany({
    where: { id: { in: unmutedRecipientIds } },
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
      agent: { select: { name: true } },
      basisScopes: { select: { scopeId: true, scopeType: true } },
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
        basis: replyMessage.basisScopes,
        channelId: payload.channelId,
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
  const channel = await deps.prisma.channel.findUnique({
    where: { id: payload.channelId },
    select: { label: true },
  })
  const channelLabel = channel?.label ?? 'New message'
  const authorName = payload.authorName
    ?? replyMessage?.agent?.name
    ?? replyMessage?.user?.displayName
    ?? 'Nessie'
  const mentionUserIds = new Set(protectedReply ? [] : payload.mentionUserIds)
  const mentionedRecipientIds = entitledUsers
    .filter((user) => mentionUserIds.has(user.id))
    .filter((user) => !shouldSuppressPushForPreferences(user.preferences, now, 'mentions'))
    .map((user) => user.id)
  const otherRecipientIds = entitledUsers
    .filter((user) => !mentionUserIds.has(user.id))
    .filter((user) => !shouldSuppressPushForPreferences(user.preferences, now, 'messages'))
    .map((user) => user.id)

  // A reply panel is the actionable destination for both a top-level message
  // and a reply. Older queued jobs simply use their message as the root.
  const deepLinkUrl = buildChannelMessagePath(payload)

  const buildPayload = (subtitle: string, badge: number): PushPayload => ({
    badge,
    title: authorName,
    subtitle,
    body: protectedReply
      ? genericReplyBody
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
