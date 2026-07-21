import type { WebhookRequest } from '@nessie/comms-connect'

/**
 * The decoded Gmail push notification. Gmail's Pub/Sub message only says "this
 * mailbox changed, the newest historyId is N" — it carries no message content.
 * The API layer matches {@link emailAddress} to a `CommsConnection` and enqueues
 * an incremental sync, which fetches the actual changes via `users.history.list`.
 */
export type GmailPubSubNotification = {
  emailAddress: string
  historyId: string
  messageId?: string
  subscription?: string
}

/** Thrown when a Pub/Sub push envelope is missing or malformed. */
export class GmailPubSubDecodeError extends Error {
  constructor(reason: string) {
    super(`[comms-google] malformed Pub/Sub notification: ${reason}`)
    this.name = 'GmailPubSubDecodeError'
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined

/**
 * Decode a Google Pub/Sub push delivery into a typed Gmail notification. The
 * inner `message.data` is base64 JSON `{ emailAddress, historyId }`. Kept as a
 * standalone export (not only inside `processWebhook`) because the shared
 * `CommunicationsConnector.processWebhook` returns `NormalizedEvent[]` with no
 * channel for the change signal — the API decodes here to route the incremental
 * sync, and `processWebhook` returns `[]`.
 */
export const decodePubSubNotification = (
  request: WebhookRequest,
): GmailPubSubNotification => {
  const envelope = asRecord(request.body)
  if (!envelope) {
    throw new GmailPubSubDecodeError('body is not an object')
  }
  const message = asRecord(envelope.message)
  if (!message || typeof message.data !== 'string') {
    throw new GmailPubSubDecodeError('missing message.data')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'))
  } catch {
    throw new GmailPubSubDecodeError('message.data is not base64 JSON')
  }
  const inner = asRecord(decoded)
  if (!inner || typeof inner.emailAddress !== 'string') {
    throw new GmailPubSubDecodeError('missing emailAddress')
  }
  if (inner.historyId === undefined || inner.historyId === null) {
    throw new GmailPubSubDecodeError('missing historyId')
  }
  return {
    emailAddress: inner.emailAddress,
    historyId: String(inner.historyId),
    messageId: typeof message.messageId === 'string' ? message.messageId : undefined,
    subscription:
      typeof envelope.subscription === 'string' ? envelope.subscription : undefined,
  }
}
