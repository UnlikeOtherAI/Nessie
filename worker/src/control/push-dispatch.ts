import type { PrismaClient } from '@prisma/client'
import type { PushDispatchJobPayload } from '@nessie/schemas'
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
 */

export type { PushDispatchSummary, PushSenders } from './push-delivery-core.js'

/** Minimal Prisma surface the dispatch handler touches — keeps tests light. */
export type PushDispatchPrisma = PushDeliveryPrisma &
  Pick<PrismaClient, 'channelMember' | 'channel' | 'user'>

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
  const now = deps.now?.() ?? new Date()
  // 3. Build the notification payloads (deep-link data + per-channel
  // coalescing). Mentioned recipients get distinct mention framing; the rest
  // keep the standard channel-label title. Muted members were filtered out
  // above for everyone — a muted channel suppresses even mention pushes, but
  // the durable UserAlert row + bell badge are still created API-side, so a
  // mention is never lost, just quiet.
  const channel = await deps.prisma.channel.findUnique({
    where: { id: payload.channelId },
    select: { label: true },
  })
  const channelLabel = channel?.label ?? 'New message'
  const mentionUserIds = new Set(payload.mentionUserIds)
  const mentionedRecipientIds = users
    .filter((user) => mentionUserIds.has(user.id))
    .filter((user) => !shouldSuppressPushForPreferences(user.preferences, now, 'mentions'))
    .map((user) => user.id)
  const otherRecipientIds = users
    .filter((user) => !mentionUserIds.has(user.id))
    .filter((user) => !shouldSuppressPushForPreferences(user.preferences, now, 'messages'))
    .map((user) => user.id)

  const buildPayload = (title: string): PushPayload => ({
    title,
    body: payload.contentSnippet.replace(/\s+/gu, ' ').trim() || 'New message',
    data: {
      channelId: payload.channelId,
      threadId: payload.threadId,
      messageId: payload.messageId,
      url: `/channels/${payload.channelId}?messageId=${payload.messageId}`,
    },
    collapseId: payload.channelId,
  })

  // 4. Deliver over native + Web Push through the shared core, once per
  // framing group.
  const deliver = (title: string, ids: string[]) =>
    deliverToRecipients({
      prisma: deps.prisma,
      apnsCreds,
      fcmCreds,
      ...(deps.webPush ? { webPush: deps.webPush } : {}),
      ...(deps.senders ? { senders: deps.senders } : {}),
      retryDelayMs,
      payload: buildPayload(title),
      recipientIds: ids,
      organizationId: payload.organizationId,
      deepLinkUrl: `/channels/${payload.channelId}`,
      messageId: payload.messageId,
      surface: { kind: 'channel', channelId: payload.channelId },
      now: deps.now ?? (() => new Date()),
    })

  if (otherRecipientIds.length > 0) {
    const delivered = await deliver(channelLabel, otherRecipientIds)
    summary.sent += delivered.sent
    summary.failed += delivered.failed
    summary.pruned += delivered.pruned
  }

  if (mentionedRecipientIds.length > 0) {
    const author = payload.authorUserId
      ? await deps.prisma.user.findUnique({
          where: { id: payload.authorUserId },
          select: { displayName: true },
        })
      : null
    const authorName = author?.displayName ?? 'Someone'
    const mentionTitle = channel?.label
      ? `${authorName} mentioned you in ${channel.label}`
      : `${authorName} mentioned you`
    const delivered = await deliver(mentionTitle, mentionedRecipientIds)
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
