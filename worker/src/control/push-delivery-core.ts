import type { PrismaClient } from '@prisma/client'
import { decryptWithKey, deriveSecretKey, safeFetch } from '@nessie/runtime'
import {
  sendApns,
  sendFcm,
  type ApnsCredentials,
  type FcmCredentials,
  type FetchLike,
  type PushPayload,
  type PushResult,
  type PushTarget,
  type WebPushCredentials,
} from '@nessie/push'
import { deliverWebPush } from './web-push-delivery.js'
import {
  PUSH_MAX_SEND_ATTEMPTS,
  shouldRetryPushFailure,
  type PushRetryProvider,
} from './push-retry.js'

/**
 * Provider-agnostic push delivery core, shared by every notification source:
 * the channel-message fan-out ({@link handlePushDispatch}) and the budget-alert
 * fan-out ({@link handleBudgetAlertDispatch}). It knows how to load the stored
 * APNs/FCM credentials and deliver one already-built {@link PushPayload} to an
 * explicit set of recipient user ids over native tokens + browser Web Push,
 * logging each attempt to `push_deliveries` and pruning dead endpoints. It holds
 * NO opinion about who the recipients are or where the deep link points — that
 * is each caller's job — so there is a single delivery implementation.
 */

/** Minimal Prisma surface the delivery core touches — keeps tests light. */
export type PushDeliveryPrisma = Pick<
  PrismaClient,
  'pushCredential' | 'deviceToken' | 'mcpOAuthSecret' | 'pushDelivery' | 'webPushSubscription'
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

// FCM's OAuth token exchange targets the service account's own `token_uri`,
// which is operator-supplied JSON and therefore attacker-controllable. Validate
// it, pin the socket to the vetted address, and refuse redirects outright — an
// unsafe URL throws and that one send fails, which is the correct outcome.
const safeFcmFetch: FetchLike = (url, init) =>
  safeFetch(
    url,
    { method: init.method, headers: init.headers, body: init.body },
    { maxRedirects: 0 },
  ).then((response) => ({ status: response.status, text: () => response.text() }))

export const defaultPushSenders: PushSenders = {
  sendApns,
  sendFcm: (creds, target, payload) => sendFcm(creds, target, payload, safeFcmFetch),
}

export type PushDispatchSummary = {
  sent: number
  failed: number
  pruned: number
}

export type LoadedPushCredentials = {
  apnsCreds: ApnsCredentials | null
  fcmCreds: FcmCredentials | null
}

const decryptSecret = async (
  prisma: Pick<PushDeliveryPrisma, 'mcpOAuthSecret'>,
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
  prisma: Pick<PushDeliveryPrisma, 'mcpOAuthSecret'>,
  authSecret: string,
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
  const p8 = await decryptSecret(prisma, authSecret, row.secretRef)
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
  prisma: Pick<PushDeliveryPrisma, 'mcpOAuthSecret'>,
  authSecret: string,
  row: { secretRef: string },
): Promise<FcmCredentials | null> => {
  const serviceAccountJson = await decryptSecret(prisma, authSecret, row.secretRef)
  if (!serviceAccountJson) {
    return null
  }
  return { serviceAccountJson }
}

/**
 * Load and decrypt the deployment's APNs + FCM credentials from the
 * `push_credentials` table. Returns nulls for absent/incomplete providers.
 */
export const loadPushCredentials = async (
  deps: { prisma: Pick<PushDeliveryPrisma, 'pushCredential' | 'mcpOAuthSecret'>; authSecret: string },
): Promise<LoadedPushCredentials> => {
  const credRows = await deps.prisma.pushCredential.findMany()
  const apnsRow = credRows.find((r) => r.provider === 'apns') ?? null
  const fcmRow = credRows.find((r) => r.provider === 'fcm') ?? null
  return {
    apnsCreds: apnsRow ? await loadApnsCreds(deps.prisma, deps.authSecret, apnsRow) : null,
    fcmCreds: fcmRow ? await loadFcmCreds(deps.prisma, deps.authSecret, fcmRow) : null,
  }
}

type NativeDeliveryInput = {
  prisma: Pick<PushDeliveryPrisma, 'deviceToken' | 'pushDelivery'>
  apnsCreds: ApnsCredentials | null
  fcmCreds: FcmCredentials | null
  senders: PushSenders
  retryDelayMs: (completedAttempt: number) => number
  payload: PushPayload
  recipientIds: string[]
  organizationId: string
  messageId: string | null
}

/**
 * Deliver the notification to every recipient's registered native (APNs/FCM)
 * device tokens, pruning the ones the provider reports dead. Never throws out of
 * the per-token loop.
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
      console.error('[push-delivery] send failed', {
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
      console.error('[push-delivery] delivery log failed', {
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

export type DeliverToRecipientsInput = {
  prisma: PushDeliveryPrisma
  apnsCreds: ApnsCredentials | null
  fcmCreds: FcmCredentials | null
  webPush?: WebPushCredentials
  senders?: PushSenders
  retryDelayMs: (completedAttempt: number) => number
  payload: PushPayload
  /** The pre-filtered recipient user ids (preferences already applied). */
  recipientIds: string[]
  organizationId: string
  /** Deep link the notification opens (e.g. `/channels/:id`, `/ops/usage`). */
  deepLinkUrl: string
  /** Optional source message; null for non-message notifications. */
  messageId?: string | null
}

/**
 * Fan one built payload out to a fixed recipient set over native + Web Push.
 * Returns the combined summary; never throws for an individual endpoint.
 */
export const deliverToRecipients = async (
  input: DeliverToRecipientsInput,
): Promise<PushDispatchSummary> => {
  const summary: PushDispatchSummary = { sent: 0, failed: 0, pruned: 0 }
  if (input.recipientIds.length === 0) {
    return summary
  }
  const senders: PushSenders = input.senders ?? defaultPushSenders
  const messageId = input.messageId ?? null

  if (input.apnsCreds || input.fcmCreds) {
    const native = await deliverNativeTokens({
      prisma: input.prisma,
      apnsCreds: input.apnsCreds,
      fcmCreds: input.fcmCreds,
      senders,
      retryDelayMs: input.retryDelayMs,
      payload: input.payload,
      recipientIds: input.recipientIds,
      organizationId: input.organizationId,
      messageId,
    })
    summary.sent += native.summary.sent
    summary.failed += native.summary.failed
    summary.pruned += native.summary.pruned
  }

  if (input.webPush) {
    const web = await deliverWebPush({
      prisma: input.prisma,
      creds: input.webPush,
      recipientIds: input.recipientIds,
      payload: input.payload,
      organizationId: input.organizationId,
      messageId,
      deepLinkUrl: input.deepLinkUrl,
    })
    summary.sent += web.sent
    summary.failed += web.failed
    summary.pruned += web.pruned
  }

  return summary
}
