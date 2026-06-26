import type { PrismaClient } from '@prisma/client'
import { decryptWithKey, deriveSecretKey } from '@nessie/runtime'
import type { PushDispatchJobPayload } from '@nessie/schemas'
import {
  sendApns,
  sendFcm,
  type ApnsCredentials,
  type FcmCredentials,
  type PushPayload,
  type PushResult,
  type PushTarget,
  type WebPushCredentials,
} from '@nessie/push'
import { shouldSuppressPushForPreferences } from './push-preferences.js'
import { deliverWebPush } from './web-push-delivery.js'
import {
  PUSH_MAX_SEND_ATTEMPTS,
  defaultPushRetryDelayMs,
  shouldRetryPushFailure,
  type PushRetryProvider,
} from './push-retry.js'

/**
 * Worker consumer for the `push.dispatch` queue topic. Resolves the recipients
 * of a freshly-posted message (channel members minus the author), loads + the
 * decrypts the stored APNs/FCM credentials, and fans a push out to each
 * recipient's registered native device tokens. Tokens the provider reports dead
 * are pruned from the registry.
 *
 * The senders, prisma client, and the auth secret are injected (see
 * {@link PushDispatchDeps}) so the handler is fully unit-testable without any
 * network or live database.
 */

/** Minimal Prisma surface the dispatch handler touches — keeps tests light. */
export type PushDispatchPrisma = Pick<
  PrismaClient,
  | 'pushCredential'
  | 'channelMember'
  | 'deviceToken'
  | 'channel'
  | 'mcpOAuthSecret'
  | 'user'
  | 'pushDelivery'
  | 'webPushSubscription'
>

export type PushSenders = {
  sendApns: (
    creds: ApnsCredentials,
    target: PushTarget,
    payload: PushPayload,
  ) => Promise<PushResult>
  sendFcm: (
    creds: FcmCredentials,
    target: PushTarget,
    payload: PushPayload,
  ) => Promise<PushResult>
}

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

export type PushDispatchSummary = {
  sent: number
  failed: number
  pruned: number
}

const decryptSecret = async (
  prisma: PushDispatchPrisma,
  authSecret: string,
  secretRef: string,
): Promise<string | null> => {
  const row = await prisma.mcpOAuthSecret.findUnique({ where: { ref: secretRef } })
  if (!row) {
    return null
  }
  return decryptWithKey(deriveSecretKey(authSecret), {
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.authTag,
  })
}

const errorMessageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const delay = async (milliseconds: number): Promise<void> => {
  if (milliseconds <= 0) {
    return
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

const resultFromError = (error: unknown): PushResult => ({
  ok: false,
  status: 0,
  deadToken: false,
  error: errorMessageOf(error),
})

const errorCodeOf = (result: PushResult): string | null => {
  if (result.ok) {
    return null
  }
  return result.error ?? `status:${result.status}`
}

type DeliveryStatus = 'sent' | 'failed' | 'dead'

const deliveryStatusOf = (result: PushResult): DeliveryStatus => {
  if (result.ok) {
    return 'sent'
  }
  return result.deadToken ? 'dead' : 'failed'
}

const sendWithRetry = async (
  input: {
    provider: PushRetryProvider
    send: () => Promise<PushResult>
    retryDelayMs: (completedAttempt: number) => number
  },
): Promise<{ attempts: number; result: PushResult }> => {
  let attempts = 0

  while (attempts < PUSH_MAX_SEND_ATTEMPTS) {
    attempts += 1
    const result = await input.send().catch(resultFromError)
    if (!shouldRetryPushFailure(input.provider, result, attempts)) {
      return { attempts, result }
    }
    await delay(input.retryDelayMs(attempts))
  }

  throw new Error('push retry loop exhausted without a final result')
}

type PushDeviceTokenForSend = {
  platform: 'ios' | 'android'
  token: string
}

type PushSendOutcome = {
  provider: PushRetryProvider
  attempts: number
  result: PushResult
}

const sendConfiguredToken = async (
  input: {
    apnsCreds: ApnsCredentials | null
    fcmCreds: FcmCredentials | null
    payload: PushPayload
    retryDelayMs: (completedAttempt: number) => number
    senders: PushSenders
    token: PushDeviceTokenForSend
  },
): Promise<PushSendOutcome | null> => {
  if (input.token.platform === 'ios' && input.apnsCreds) {
    const apnsCreds = input.apnsCreds
    return {
      provider: 'apns',
      ...(await sendWithRetry({
        provider: 'apns',
        retryDelayMs: input.retryDelayMs,
        send: () => input.senders.sendApns(
          apnsCreds,
          { token: input.token.token },
          input.payload,
        ),
      })),
    }
  }

  if (input.token.platform === 'android' && input.fcmCreds) {
    const fcmCreds = input.fcmCreds
    return {
      provider: 'fcm',
      ...(await sendWithRetry({
        provider: 'fcm',
        retryDelayMs: input.retryDelayMs,
        send: () => input.senders.sendFcm(
          fcmCreds,
          { token: input.token.token },
          input.payload,
        ),
      })),
    }
  }

  return null
}

/**
 * Build the decrypted APNs credentials from the `push_credentials` row + the
 * `.p8` plaintext, or null if the row is incomplete / the secret is missing.
 */
const loadApnsCreds = async (
  deps: Pick<PushDispatchDeps, 'prisma' | 'authSecret'>,
  row: {
    secretRef: string
    apnsKeyId: string | null
    apnsTeamId: string | null
    apnsTopic: string | null
    apnsEnvironment: 'sandbox' | 'production' | null
  },
): Promise<ApnsCredentials | null> => {
  if (!row.apnsKeyId || !row.apnsTeamId || !row.apnsTopic) {
    return null
  }
  const p8 = await decryptSecret(deps.prisma, deps.authSecret, row.secretRef)
  if (!p8) {
    return null
  }
  return {
    p8,
    keyId: row.apnsKeyId,
    teamId: row.apnsTeamId,
    topic: row.apnsTopic,
    environment: row.apnsEnvironment ?? 'production',
  }
}

const loadFcmCreds = async (
  deps: Pick<PushDispatchDeps, 'prisma' | 'authSecret'>,
  row: { secretRef: string },
): Promise<FcmCredentials | null> => {
  const serviceAccountJson = await decryptSecret(
    deps.prisma,
    deps.authSecret,
    row.secretRef,
  )
  if (!serviceAccountJson) {
    return null
  }
  return { serviceAccountJson }
}

type NativeDeliveryInput = {
  prisma: Pick<PushDispatchPrisma, 'deviceToken' | 'pushDelivery'>
  apnsCreds: ApnsCredentials | null
  fcmCreds: FcmCredentials | null
  senders: PushSenders
  retryDelayMs: (completedAttempt: number) => number
  payload: PushPayload
  recipientIds: string[]
  organizationId: string
  messageId: string
}

/**
 * Deliver the notification to every recipient's registered native (APNs/FCM)
 * device tokens, pruning the ones the provider reports dead. Returns a summary
 * plus the number of tokens considered (for logging). Never throws out of the
 * per-token loop.
 */
const deliverNativeTokens = async (
  input: NativeDeliveryInput,
): Promise<{ summary: PushDispatchSummary; tokenCount: number }> => {
  const summary: PushDispatchSummary = { sent: 0, failed: 0, pruned: 0 }
  const tokens = await input.prisma.deviceToken.findMany({
    where: { userId: { in: input.recipientIds } },
  })
  if (tokens.length === 0) {
    return { summary, tokenCount: 0 }
  }

  const deadTokenIds: string[] = []
  for (const token of tokens) {
    let outcome: PushSendOutcome | null = null
    try {
      outcome = await sendConfiguredToken({
        apnsCreds: input.apnsCreds,
        fcmCreds: input.fcmCreds,
        payload: input.payload,
        retryDelayMs: input.retryDelayMs,
        senders: input.senders,
        token,
      })
    } catch (err) {
      summary.failed += 1
      console.error('[push-dispatch] send failed', {
        tokenId: token.id,
        platform: token.platform,
        err,
      })
      continue
    }

    if (!outcome) {
      // No configured provider for this platform — skip silently.
      continue
    }

    if (outcome.result.ok) {
      summary.sent += 1
    } else {
      summary.failed += 1
    }
    if (outcome.result.deadToken) {
      deadTokenIds.push(token.id)
    }

    try {
      await input.prisma.pushDelivery.create({
        data: {
          organizationId: input.organizationId,
          userId: token.userId,
          messageId: input.messageId,
          provider: outcome.provider,
          status: deliveryStatusOf(outcome.result),
          errorCode: errorCodeOf(outcome.result),
          attempts: outcome.attempts,
        },
      })
    } catch (err) {
      console.error('[push-dispatch] delivery log failed', {
        tokenId: token.id,
        platform: token.platform,
        err,
      })
    }
  }

  if (deadTokenIds.length > 0) {
    await input.prisma.deviceToken.deleteMany({ where: { id: { in: deadTokenIds } } })
    summary.pruned = deadTokenIds.length
  }

  return { summary, tokenCount: tokens.length }
}

export const handlePushDispatch = async (
  deps: PushDispatchDeps,
  payload: PushDispatchJobPayload,
): Promise<PushDispatchSummary> => {
  const summary: PushDispatchSummary = { sent: 0, failed: 0, pruned: 0 }
  const senders: PushSenders = deps.senders ?? { sendApns, sendFcm }
  const retryDelayMs = deps.retryDelayMs ?? defaultPushRetryDelayMs

  const webPushEnabled = Boolean(deps.webPush)

  // 1. Load native credentials. Nothing to do when no native provider AND no
  // web push is configured.
  const credRows = await deps.prisma.pushCredential.findMany()
  const apnsRow = credRows.find((r) => r.provider === 'apns') ?? null
  const fcmRow = credRows.find((r) => r.provider === 'fcm') ?? null
  if (!apnsRow && !fcmRow && !webPushEnabled) {
    return summary
  }

  const apnsCreds = apnsRow ? await loadApnsCreds(deps, apnsRow) : null
  const fcmCreds = fcmRow ? await loadFcmCreds(deps, fcmRow) : null
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

  // 4. Native delivery to registered APNs/FCM device tokens.
  let tokenCount = 0
  if (apnsCreds || fcmCreds) {
    const native = await deliverNativeTokens({
      prisma: deps.prisma,
      apnsCreds,
      fcmCreds,
      senders,
      retryDelayMs,
      payload: pushPayload,
      recipientIds,
      organizationId: payload.organizationId,
      messageId: payload.messageId,
    })
    summary.sent += native.summary.sent
    summary.failed += native.summary.failed
    summary.pruned += native.summary.pruned
    tokenCount = native.tokenCount
  }

  // 5. Web Push delivery, in addition to native, when VAPID creds are present.
  let webPushSubscriptions = 0
  if (deps.webPush) {
    const web = await deliverWebPush({
      prisma: deps.prisma,
      creds: deps.webPush,
      recipientIds,
      payload: pushPayload,
      organizationId: payload.organizationId,
      messageId: payload.messageId,
      channelId: payload.channelId,
    })
    summary.sent += web.sent
    summary.failed += web.failed
    summary.pruned += web.pruned
    webPushSubscriptions = web.sent + web.failed
  }

  console.log('[push-dispatch] done', {
    messageId: payload.messageId,
    channelId: payload.channelId,
    recipients: recipientIds.length,
    tokens: tokenCount,
    webPushSubscriptions,
    sent: summary.sent,
    failed: summary.failed,
    pruned: summary.pruned,
  })

  return summary
}
