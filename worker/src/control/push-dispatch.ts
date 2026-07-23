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
 * of a freshly-posted message (channel members minus the author), then hands the
 * built payload + recipient set to the shared {@link deliverToRecipients} core,
 * which loads credentials and fans out over native APNs/FCM + browser Web Push.
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

  // 2. Resolve recipients: channel members minus the author, muted members,
  // disabled push preferences, and users currently inside quiet hours.
  const members = await deps.prisma.channelMember.findMany({
    where: { channelId: payload.channelId, userId: { not: payload.authorUserId } },
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
  const recipientIds = users
    .filter((user) => !shouldSuppressPushForPreferences(user.preferences, now))
    .map((user) => user.id)
  if (recipientIds.length === 0) {
    return summary
  }

  // 3. Build the notification payload, shared by native + web push delivery
  // (deep-link data + per-channel coalescing).
  const channel = await deps.prisma.channel.findUnique({
    where: { id: payload.channelId },
    select: { label: true },
  })
  const pushPayload: PushPayload = {
    title: channel?.label ?? 'New message',
    body: payload.contentSnippet,
    data: {
      channelId: payload.channelId,
      threadId: payload.threadId,
      messageId: payload.messageId,
    },
    collapseId: payload.channelId,
  }

  // 4. Deliver over native + Web Push through the shared core.
  const delivered = await deliverToRecipients({
    prisma: deps.prisma,
    apnsCreds,
    fcmCreds,
    ...(deps.webPush ? { webPush: deps.webPush } : {}),
    ...(deps.senders ? { senders: deps.senders } : {}),
    retryDelayMs,
    payload: pushPayload,
    recipientIds,
    organizationId: payload.organizationId,
    deepLinkUrl: `/channels/${payload.channelId}`,
    messageId: payload.messageId,
  })
  summary.sent += delivered.sent
  summary.failed += delivered.failed
  summary.pruned += delivered.pruned

  console.log('[push-dispatch] done', {
    messageId: payload.messageId,
    channelId: payload.channelId,
    recipients: recipientIds.length,
    sent: summary.sent,
    failed: summary.failed,
    pruned: summary.pruned,
  })

  return summary
}
