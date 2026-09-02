/**
 * SES notification payloads, discriminated strictly.
 *
 * One SNS topic carries two different things: inbound *receipt* notifications
 * from the receipt rule, and *event* notifications (bounce / complaint /
 * delivery) from the configuration set. They share an envelope and nothing
 * else, so each is parsed by its own shape and anything that matches neither is
 * rejected rather than partially interpreted.
 *
 * The routing rule this file exists to enforce: an inbound message is addressed
 * to whoever the SES **receipt envelope** says, never to what the MIME
 * `To:`/`Cc:` headers claim. Those headers are written by the sender — they can
 * omit the real (Bcc) recipient entirely and can name a mailbox in another
 * tenant.
 */

import { normalizeAddress } from './address.js'
import type { ReceiptVerdicts } from './classification.js'

export type SesInboundReceipt = {
  kind: 'inbound'
  /** SES's own message id — the inbound idempotency key. */
  sesMessageId: string
  /** Envelope recipients, lowercased. The routing truth. */
  envelopeRecipients: string[]
  envelopeFrom: string | null
  s3ObjectKey: string | null
  s3Bucket: string | null
  verdicts: ReceiptVerdicts
  receivedAt: string
  /** Headers SES parsed for us; still untrusted, still only used for display. */
  commonHeaders?: Record<string, unknown>
}

export type SesDeliveryEvent = {
  kind: 'bounce' | 'complaint' | 'delivery'
  sesMessageId: string
  /** Affected recipients, lowercased. */
  recipients: string[]
  /** `Permanent` / `Transient` for a bounce; undefined otherwise. */
  bounceType?: string
  bounceSubType?: string
  complaintType?: string
  detail?: string
  occurredAt: string
}

export type SesNotification = SesInboundReceipt | SesDeliveryEvent

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null

const asAddressList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      if (typeof entry === 'string') return normalizeAddress(entry)
      const record = asRecord(entry)
      return record ? normalizeAddress(asString(record.emailAddress) ?? undefined) : null
    })
    .filter((entry): entry is string => Boolean(entry))
}

const parseVerdicts = (receipt: Record<string, unknown>): ReceiptVerdicts => {
  const status = (key: string): string | null => {
    const verdict = asRecord(receipt[key])
    return verdict ? asString(verdict.status) : null
  }
  return {
    dkim: status('dkimVerdict'),
    dmarc: status('dmarcVerdict'),
    spam: status('spamVerdict'),
    spf: status('spfVerdict'),
    virus: status('virusVerdict'),
  }
}

/**
 * Parse the inner `Message` string of an SNS notification.
 * Returns null when the payload is neither a receipt nor a known event — an
 * unrecognized shape is dropped, never guessed at.
 */
export const parseSesNotification = (rawMessage: string): SesNotification | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawMessage)
  } catch {
    return null
  }
  const body = asRecord(parsed)
  if (!body) return null

  const mail = asRecord(body.mail)
  const sesMessageId = mail ? asString(mail.messageId) : null

  // ── Inbound receipt ──────────────────────────────────────────────────────
  const receipt = asRecord(body.receipt)
  const notificationType = asString(body.notificationType) ?? asString(body.eventType)
  if (receipt && mail && (notificationType === 'Received' || body.content !== undefined || !notificationType)) {
    const action = asRecord(receipt.action)
    const envelopeRecipients = asAddressList(receipt.recipients ?? mail.destination)
    if (!sesMessageId || envelopeRecipients.length === 0) return null
    return {
      commonHeaders: asRecord(mail.commonHeaders) ?? undefined,
      envelopeFrom: normalizeAddress(asString(mail.source) ?? undefined),
      envelopeRecipients,
      kind: 'inbound',
      receivedAt: asString(mail.timestamp) ?? asString(receipt.timestamp) ?? new Date().toISOString(),
      s3Bucket: action ? asString(action.bucketName) : null,
      s3ObjectKey: action ? asString(action.objectKey) : null,
      sesMessageId,
      verdicts: parseVerdicts(receipt),
    }
  }

  if (!sesMessageId) return null

  // ── Configuration-set events ─────────────────────────────────────────────
  const bounce = asRecord(body.bounce)
  if (bounce && (notificationType === 'Bounce' || notificationType === 'BOUNCE')) {
    return {
      bounceSubType: asString(bounce.bounceSubType) ?? undefined,
      bounceType: asString(bounce.bounceType) ?? undefined,
      detail: asString(bounce.reportingMTA) ?? undefined,
      kind: 'bounce',
      occurredAt: asString(bounce.timestamp) ?? new Date().toISOString(),
      recipients: asAddressList(bounce.bouncedRecipients),
      sesMessageId,
    }
  }

  const complaint = asRecord(body.complaint)
  if (complaint && (notificationType === 'Complaint' || notificationType === 'COMPLAINT')) {
    return {
      complaintType: asString(complaint.complaintFeedbackType) ?? undefined,
      kind: 'complaint',
      occurredAt: asString(complaint.timestamp) ?? new Date().toISOString(),
      recipients: asAddressList(complaint.complainedRecipients),
      sesMessageId,
    }
  }

  const delivery = asRecord(body.delivery)
  if (delivery && (notificationType === 'Delivery' || notificationType === 'DELIVERY')) {
    return {
      kind: 'delivery',
      occurredAt: asString(delivery.timestamp) ?? new Date().toISOString(),
      recipients: asAddressList(delivery.recipients),
      sesMessageId,
    }
  }

  return null
}

/**
 * Only a *permanent* bounce suppresses. A transient bounce is a full mailbox or
 * a greylist — suppressing on one would silently retire a correspondent who is
 * reachable tomorrow.
 */
export const bounceIsPermanent = (event: SesDeliveryEvent): boolean =>
  event.kind === 'bounce' && (event.bounceType ?? '').toLowerCase() === 'permanent'
