import type { PrismaClient } from '@prisma/client'
import {
  sendWebPush,
  type PushPayload,
  type PushResult,
  type WebPushCredentials,
  type WebPushTarget,
} from '@nessie/push'

/**
 * Browser Web Push fan-out for a dispatched notification. Runs alongside (not
 * instead of) the native APNs/FCM delivery in {@link handlePushDispatch}: it
 * loads the recipients' stored {@link WebPushSubscription} rows, sends each the
 * same notification (with a deep-link `data.url` the service worker opens),
 * prunes subscriptions the push service reports gone, and logs each attempt to
 * the `push_deliveries` ledger as `provider: 'webpush'`.
 *
 * The prisma surface and sender are injected so the path is unit-testable with
 * no live database or network.
 */

/** Minimal Prisma surface this helper touches — keeps tests light. */
export type WebPushDeliveryPrisma = Pick<
  PrismaClient,
  'webPushSubscription' | 'pushDelivery'
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
  messageId: string
  channelId: string
  /** Sender injection for tests (default: the real {@link sendWebPush}). */
  sender?: WebPushSender
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
const buildWebPayload = (payload: PushPayload, channelId: string): PushPayload => ({
  ...payload,
  data: {
    ...(payload.data ?? {}),
    url: `/channels/${channelId}`,
  },
})

export const deliverWebPush = async (
  input: DeliverWebPushInput,
): Promise<WebPushDeliverySummary> => {
  const summary: WebPushDeliverySummary = { sent: 0, failed: 0, pruned: 0 }
  if (input.recipientIds.length === 0) {
    return summary
  }

  const subscriptions = await input.prisma.webPushSubscription.findMany({
    where: { userId: { in: input.recipientIds } },
  })
  if (subscriptions.length === 0) {
    return summary
  }

  const send = input.sender ?? sendWebPush
  const webPayload = buildWebPayload(input.payload, input.channelId)
  const deadSubscriptionIds: string[] = []

  for (const subscription of subscriptions) {
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
      result = resultFromError(err)
    }

    if (result.ok) {
      summary.sent += 1
    } else {
      summary.failed += 1
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
