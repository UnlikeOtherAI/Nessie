import type { PrismaClient } from '@prisma/client'
import {
  WebPushClient,
  type PushPayload,
  type PushResult,
  type WebPushCredentials,
  type WebPushFetch,
  type WebPushTarget,
} from '@nessie/push'
import { safeFetch, UrlSafetyError, type SafeFetchOptions } from '@nessie/runtime'

import {
  claimPushSend,
  markPushSendSent,
  pushEndpointKey,
  releasePushSendClaim,
  type PushSendClaimRef,
} from './push-send-claim.js'

/**
 * Browser Web Push fan-out for a dispatched notification. Runs alongside (not
 * instead of) the native APNs/FCM delivery in {@link handlePushDispatch}: it
 * loads the recipients' stored {@link WebPushSubscription} rows, sends each the
 * same notification (with a deep-link `data.url` the service worker opens),
 * prunes subscriptions the push service reports gone, and logs each attempt to
 * the `push_deliveries` ledger as `provider: 'webpush'`. Each POST is gated by a
 * `push_send_claims` row for `(notificationKey, endpoint)` so a redelivered
 * dispatch job shows the notification once, not twice — and the claim is only
 * made permanent once the push service has accepted it, so a POST that failed
 * is retried by the next delivery instead of being suppressed forever.
 *
 * The prisma surface and sender are injected so the path is unit-testable with
 * no live database or network.
 */

/** Minimal Prisma surface this helper touches — keeps tests light. */
export type WebPushDeliveryPrisma = Pick<
  PrismaClient,
  '$executeRaw' | 'webPushSubscription' | 'pushDelivery'
>

/** Web Push sender, injected so tests can stub it (default: real network). */
export type WebPushSender = (
  creds: WebPushCredentials,
  target: WebPushTarget,
  payload: PushPayload,
) => Promise<PushResult>

export type WebPushDeliverySummary = {
  sent: number
  failed: number
  pruned: number
}

export type DeliverWebPushInput = {
  prisma: WebPushDeliveryPrisma
  creds: WebPushCredentials
  recipientIds: string[]
  /** The base notification already built for native delivery (title/body/data). */
  payload: PushPayload
  organizationId: string
  /** Optional source message; null for non-message notifications (budget alerts). */
  messageId: string | null
  /**
   * The notification's durable identity, claimed per subscription before the
   * POST so a redelivered dispatch job cannot notify the same browser twice.
   * Threaded down from {@link deliverToRecipients}; see `./push-send-claim.ts`.
   */
  notificationKey: string
  /** Deep link the service worker focuses/opens (e.g. `/channels/:id`, `/ops/usage`). */
  deepLinkUrl: string
  /** Sender injection for tests (default: the real {@link WebPushClient} on the pinned transport). */
  sender?: WebPushSender
  /**
   * safeFetch options for the default sender's pinned transport, injected so
   * tests can exercise the real dial without DNS (e.g. a stubbed resolveHost).
   */
  fetchOptions?: SafeFetchOptions
}

type DeliveryStatus = 'sent' | 'failed' | 'dead'

const deliveryStatusOf = (result: PushResult): DeliveryStatus => {
  if (result.ok) {
    return 'sent'
  }
  return result.deadToken ? 'dead' : 'failed'
}

const errorCodeOf = (result: PushResult): string | null => {
  if (result.ok) {
    return null
  }
  return result.error ?? `status:${result.status}`
}

const errorMessageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const resultFromError = (error: unknown): PushResult => ({
  ok: false,
  status: 0,
  deadToken: false,
  error: errorMessageOf(error),
})

/**
 * Build the Web Push payload: the same notification plus a `data.url` deep link
 * the service worker focuses/opens. All `data` values stay strings.
 */
const buildWebPayload = (payload: PushPayload, deepLinkUrl: string): PushPayload => ({
  ...payload,
  data: {
    ...(payload.data ?? {}),
    url: deepLinkUrl,
  },
})

// The subscription endpoint is stored operator/user input and was SSRF-checked
// at subscribe time, but DNS can be repointed to an internal host afterwards.
// Re-validate AND pin the socket to the vetted addresses at dial time, and
// refuse redirects outright: a push service answering 3xx must never cause the
// credentialed POST to be replayed at a cross-origin location.
const safeWebPushFetch = (options?: SafeFetchOptions): WebPushFetch => (url, init) =>
  safeFetch(
    url,
    { method: init.method, headers: init.headers, body: init.body },
    { ...options, maxRedirects: 0 },
  ).then((response) => ({ status: response.status, text: () => response.text() }))

const defaultWebPushSender = (options?: SafeFetchOptions): WebPushSender =>
  (creds, target, payload) =>
    new WebPushClient(creds, safeWebPushFetch(options)).send(target, payload)

export const deliverWebPush = async (
  input: DeliverWebPushInput,
): Promise<WebPushDeliverySummary> => {
  const summary: WebPushDeliverySummary = { sent: 0, failed: 0, pruned: 0 }
  if (input.recipientIds.length === 0) {
    return summary
  }

  const subscriptions = await input.prisma.webPushSubscription.findMany({
    where: { userId: { in: input.recipientIds }, organizationId: input.organizationId },
  })
  if (subscriptions.length === 0) {
    return summary
  }

  const send = input.sender ?? defaultWebPushSender(input.fetchOptions)
  const webPayload = buildWebPayload(input.payload, input.deepLinkUrl)
  const deadSubscriptionIds: string[] = []

  for (const subscription of subscriptions) {
    // The duplicate gate: claimed before the credentialed POST, so a
    // redelivered job loses the claim and skips this endpoint instead of
    // showing the same notification twice. A loser is not a failure.
    const claimRef: PushSendClaimRef = {
      endpointKey: pushEndpointKey('webpush', subscription.endpoint),
      notificationKey: input.notificationKey,
      organizationId: input.organizationId,
    }
    const claimed = await claimPushSend(input.prisma, {
      ...claimRef,
      provider: 'webpush',
    })
    if (!claimed) {
      continue
    }
    let result: PushResult
    try {
      result = await send(
        input.creds,
        {
          endpoint: subscription.endpoint,
          p256dh: subscription.p256dh,
          auth: subscription.auth,
        },
        webPayload,
      )
    } catch (err) {
      // A guard failure means we simply do NOT POST (SSRF-safe either way). Do
      // not prune on it: the SSRF guard throws the same error for a genuinely
      // blocked host and for a transient DNS hiccup, so pruning would silently
      // destroy a valid subscription on a momentary resolver blip. Count it as a
      // (non-dead) failure; a truly blocked endpoint just keeps failing harmlessly.
      result = err instanceof UrlSafetyError
        ? { ok: false, status: 0, deadToken: false, error: 'endpoint failed safety check' }
        : resultFromError(err)
    }

    if (result.ok) {
      summary.sent += 1
      // The one transition that makes a claim permanent: the push service
      // accepted it, so a second POST would be a duplicate notification.
      await markPushSendSent(input.prisma, claimRef)
    } else {
      summary.failed += 1
      // Nothing was accepted — a refused safety check, a transport error, a
      // rejection. Give the claim back so a redelivery of this job actually
      // retries; a subscription the service reported gone is pruned below, so
      // releasing cannot resurrect a dead endpoint.
      await releasePushSendClaim(input.prisma, claimRef)
    }
    if (result.deadToken) {
      deadSubscriptionIds.push(subscription.id)
    }

    try {
      await input.prisma.pushDelivery.create({
        data: {
          organizationId: input.organizationId,
          userId: subscription.userId,
          messageId: input.messageId,
          provider: 'webpush',
          status: deliveryStatusOf(result),
          errorCode: errorCodeOf(result),
          attempts: 1,
        },
      })
    } catch (err) {
      console.error('[web-push-delivery] delivery log failed', {
        subscriptionId: subscription.id,
        err,
      })
    }
  }

  if (deadSubscriptionIds.length > 0) {
    await input.prisma.webPushSubscription.deleteMany({
      where: { id: { in: deadSubscriptionIds } },
    })
    summary.pruned = deadSubscriptionIds.length
  }

  return summary
}
