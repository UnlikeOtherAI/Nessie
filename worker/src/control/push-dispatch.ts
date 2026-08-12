import type { PrismaClient } from '@prisma/client'
import { canUserReadDisclosureBasis, type BasisScopeRow } from '@nessie/runtime'
import { buildChannelMessagePath, type PushDispatchJobPayload } from '@nessie/schemas'
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
  Pick<PrismaClient,
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

type GenericReplyMessage = {
  agentId: string | null
  basisScopes: BasisScopeRow[]
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
  const replyMessage: GenericReplyMessage | null = protectedReply
    ? await deps.prisma.message.findUnique({
      where: { id: payload.messageId },
      select: {
        agentId: true,
        basisScopes: { select: { scopeId: true, scopeType: true } },
      },
    })
    : null
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
  const mentionUserIds = new Set(protectedReply ? [] : payload.mentionUserIds)
  const mentionedRecipientIds = entitledUsers
    .filter((user) => mentionUserIds.has(user.id))
    .filter((user) => !shouldSuppressPushForPreferences(user.preferences, now, 'mentions'))
    .map((user) => user.id)
  const otherRecipientIds = entitledUsers
    .filter((user) => !mentionUserIds.has(user.id))
    .filter((user) => !shouldSuppressPushForPreferences(user.preferences, now, 'messages'))
    .map((user) => user.id)

  // New jobs always carry the reply root. Keep the previous channel/message
  // route for already-queued jobs, whose reply root was not persisted yet.
  const deepLinkUrl = payload.rootMessageId
    ? buildChannelMessagePath(payload)
    : `/channels/${payload.channelId}?messageId=${payload.messageId}`

  const buildPayload = (title: string): PushPayload => ({
    title,
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
      deepLinkUrl,
      messageId: payload.messageId,
      surface: {
        channelId: payload.channelId,
        kind: 'channel',
        threadId: payload.threadId,
      },
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
