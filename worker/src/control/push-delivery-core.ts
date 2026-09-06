import type { PrismaClient } from '@prisma/client'
import { safeFetch } from '@nessie/runtime'
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
import { findRecipientsViewingPushSurface } from './push-surface-presence.js'
import type { PushSurfaceTarget } from './push-surface-presence.js'
import {
  claimPushSend,
  markPushSendSent,
  pushEndpointKey,
  releasePushSendClaim,
  type PushSendClaimRef,
} from './push-send-claim.js'

/**
 * Provider-agnostic push delivery core, shared by every notification source:
 * the channel-message fan-out ({@link handlePushDispatch}) and the budget-alert
 * fan-out ({@link handleBudgetAlertDispatch}). It delivers one already-built
 * {@link PushPayload} to an explicit set of recipient user ids over native
 * tokens + browser Web Push, logging each attempt to `push_deliveries` and
 * pruning dead endpoints. It holds NO opinion about who the recipients are or
 * where the deep link points — that is each caller's job — so there is a single
 * delivery implementation. Credential loading lives in `./push-credentials.ts`
 * and is re-exported here so every existing import path keeps working.
 *
 * **No accepted send is sent twice.** Every caller supplies a
 * `notificationKey` — the notification's own durable identity, matching its
 * enqueue idempotency key — and this core claims a `push_send_claims` row for
 * `(notificationKey, endpoint)` *before* it calls a provider
 * (`./push-send-claim.ts`). A redelivered job loses that claim and skips the
 * send instead of notifying the device twice. The claim is only made permanent
 * once a provider has accepted; a send that definitively failed releases it, so
 * a later redelivery genuinely retries rather than silently dropping a ring.
 * `push_deliveries` keeps its unchanged post-send meaning: the outcome log ops
 * reads, with the provider, the status and the error code.
 */

export { loadPushCredentials } from './push-credentials.js'
export type { LoadedPushCredentials } from './push-credentials.js'

/** Minimal Prisma surface the delivery core touches — keeps tests light. */
export type PushDeliveryPrisma = Pick<
  PrismaClient,
  | '$executeRaw'
  | 'pushCredential'
  | 'deviceToken'
  | 'mcpOAuthSecret'
  | 'pushDelivery'
  | 'userPushSurfacePresence'
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
  apnsEnvironment?: 'sandbox' | 'production' | null
}

type PushSendOutcome = {
  provider: PushRetryProvider
  attempts: number
  result: PushResult
}

/**
 * Which transport this token would actually be sent over, or null when the
 * deployment has no credentials for its platform. Resolved before the claim so
 * a token nothing can be sent to never burns one.
 */
const configuredTransportOf = (
  token: PushDeviceTokenForSend,
  apnsCreds: ApnsCredentials | null,
  fcmCreds: FcmCredentials | null,
): PushRetryProvider | null => {
  if (token.platform === 'ios' && apnsCreds) {
    return 'apns'
  }
  if (token.platform === 'android' && fcmCreds) {
    return 'fcm'
  }
  return null
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
    const apnsCreds = input.token.apnsEnvironment
      ? { ...input.apnsCreds, environment: input.token.apnsEnvironment }
      : input.apnsCreds
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

type NativeDeliveryInput = {
  prisma: Pick<
    PushDeliveryPrisma,
    '$executeRaw' | 'deviceToken' | 'pushDelivery' | 'userPushSurfacePresence'
  >
  apnsCreds: ApnsCredentials | null
  fcmCreds: FcmCredentials | null
  senders: PushSenders
  retryDelayMs: (completedAttempt: number) => number
  payload: PushPayload
  recipientIds: string[]
  organizationId: string
  messageId: string | null
  notificationKey: string
  surface: PushSurfaceTarget
  now: () => Date
  bypassSurfaceSuppression: boolean
}

/**
 * Deliver the notification to every recipient's registered native (APNs/FCM)
 * device tokens, pruning the ones the provider reports dead.
 *
 * A provider failure never escapes the per-token loop — one dead endpoint must
 * not abort the rest of the fan-out. The claim statements around it deliberately
 * do escape: they sit outside the try, so a database error taking, releasing or
 * completing a claim aborts the batch and fails the job. Without a working
 * `push_send_claims` table there is no duplicate guard, and continuing anyway
 * would send unguarded.
 */
const deliverNativeTokens = async (
  input: NativeDeliveryInput,
): Promise<{ summary: PushDispatchSummary; tokenCount: number }> => {
  const summary: PushDispatchSummary = { sent: 0, failed: 0, pruned: 0 }
  const tokens = await input.prisma.deviceToken.findMany({
    where: {
      organizationId: input.organizationId,
      userId: { in: input.recipientIds },
      inactiveAt: null,
    },
  })
  if (tokens.length === 0) {
    return { summary, tokenCount: 0 }
  }

  const deadTokenIds: string[] = []
  const checkedRecipients = new Set<string>()
  const recipientsViewingTarget = new Set<string>()
  for (const token of tokens) {
    if (!input.bypassSurfaceSuppression && !checkedRecipients.has(token.userId)) {
      checkedRecipients.add(token.userId)
      const viewers = await findRecipientsViewingPushSurface(input.prisma, {
        now: input.now(),
        organizationId: input.organizationId,
        recipientIds: [token.userId],
        surface: input.surface,
      })
      for (const viewer of viewers) recipientsViewingTarget.add(viewer)
    }
    if (!input.bypassSurfaceSuppression && recipientsViewingTarget.has(token.userId)) {
      continue
    }
    // Resolved before the claim: a platform with no configured credentials is
    // not a send, so it must not consume this notification's claim either.
    const transport = configuredTransportOf(token, input.apnsCreds, input.fcmCreds)
    if (!transport) {
      // No configured provider for this platform — skip silently.
      continue
    }
    // The duplicate gate. Everything above re-decides whether this device
    // should be rung at all; from here down a provider is contacted, so the
    // claim is taken first and a loser skips the send rather than failing the
    // job. `sendConfiguredToken`'s transient-failure retries all happen inside
    // this one claim, so a retry can never duplicate a send that succeeded.
    const claimRef: PushSendClaimRef = {
      endpointKey: pushEndpointKey(transport, token.token),
      notificationKey: input.notificationKey,
      organizationId: input.organizationId,
    }
    const claimed = await claimPushSend(input.prisma, {
      ...claimRef,
      provider: transport,
    })
    if (!claimed) {
      continue
    }
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
      // Nothing reached the provider, so the claim must not outlive the
      // attempt: give it back and let the next delivery of this job try again.
      await releasePushSendClaim(input.prisma, claimRef)
      continue
    }

    if (!outcome) {
      // Unreachable: `configuredTransportOf` above already refused this token.
      await releasePushSendClaim(input.prisma, claimRef)
      continue
    }

    if (outcome.result.ok) {
      summary.sent += 1
      // The one transition that makes a claim permanent. Only now is a second
      // send of this notification to this device a duplicate.
      await markPushSendSent(input.prisma, claimRef)
    } else {
      summary.failed += 1
      // A definitive failure, retries already exhausted. Releasing is what
      // stops a ring that never happened being suppressed forever; a dead
      // endpoint is pruned below, so releasing cannot make it be retried.
      await releasePushSendClaim(input.prisma, claimRef)
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
  /** Optional browser-only framing; calls must not put their meeting URI in native payloads. */
  webPayload?: PushPayload
  /** The pre-filtered recipient user ids (preferences already applied). */
  recipientIds: string[]
  organizationId: string
  /** Deep link the notification opens (e.g. `/channels/:id`, `/ops/usage`). */
  deepLinkUrl: string
  /** Structured equivalent of the deep link for exact page-aware suppression. */
  surface: PushSurfaceTarget
  /** Current clock, sampled immediately before every delivery path. */
  now: () => Date
  /** Optional source message; null for non-message notifications. */
  messageId?: string | null
  /**
   * The notification's durable identity, and the reason a redelivered job does
   * not notify twice. Required, never optional: a caller that could omit it
   * would be a second unclaimed send path, which is the defect this exists to
   * close (horizontal-scaling invariant 3). Derive it from the fact that makes
   * the notification unique and match its enqueue idempotency key —
   * `push:message:<id>`, `push:attention:<alertId>` — never from a clock
   * reading or a random value.
   */
  notificationKey: string
  /** Rings every device, including devices already viewing the destination. */
  bypassSurfaceSuppression?: boolean
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
  const recipientsViewingTarget = input.bypassSurfaceSuppression
    ? new Set<string>()
    : await findRecipientsViewingPushSurface(input.prisma, {
      now: input.now(),
      organizationId: input.organizationId,
      recipientIds: input.recipientIds,
      surface: input.surface,
    })
  const recipientIds = input.recipientIds.filter((id) => !recipientsViewingTarget.has(id))
  if (recipientIds.length === 0) {
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
      recipientIds,
      organizationId: input.organizationId,
      messageId,
      notificationKey: input.notificationKey,
      surface: input.surface,
      now: input.now,
      bypassSurfaceSuppression: input.bypassSurfaceSuppression ?? false,
    })
    summary.sent += native.summary.sent
    summary.failed += native.summary.failed
    summary.pruned += native.summary.pruned
  }

  if (input.webPush) {
    const recipientsViewingTarget = input.bypassSurfaceSuppression
      ? new Set<string>()
      : await findRecipientsViewingPushSurface(input.prisma, {
        now: input.now(),
        organizationId: input.organizationId,
        recipientIds,
        surface: input.surface,
      })
    const webRecipientIds = recipientIds.filter((id) => !recipientsViewingTarget.has(id))
    if (webRecipientIds.length === 0) {
      return summary
    }
    const web = await deliverWebPush({
      prisma: input.prisma,
      creds: input.webPush,
      recipientIds: webRecipientIds,
      payload: input.webPayload ?? input.payload,
      organizationId: input.organizationId,
      messageId,
      notificationKey: input.notificationKey,
      deepLinkUrl: input.deepLinkUrl,
    })
    summary.sent += web.sent
    summary.failed += web.failed
    summary.pruned += web.pruned
  }

  return summary
}
