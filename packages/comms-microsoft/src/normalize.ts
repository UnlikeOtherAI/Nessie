import {
  buildCanonicalMessageId,
  type EventParticipant,
  type NormalizedEvent,
} from '@nessie/comms-connect'

import type { MicrosoftMessage, MicrosoftRecipient } from './client.js'

export const MICROSOFT_MAIL_VISIBILITY = 'private-mailbox'

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const participant = (
  recipient: MicrosoftRecipient | undefined,
  role: EventParticipant['role'],
): EventParticipant | undefined => {
  const email = nonEmpty(recipient?.emailAddress?.address)
  if (!email) return undefined
  return {
    externalId: email,
    email,
    displayName: nonEmpty(recipient?.emailAddress?.name),
    role,
  }
}

const participants = (message: MicrosoftMessage): EventParticipant[] => {
  const collect = (
    recipients: MicrosoftRecipient[] | undefined,
    role: EventParticipant['role'],
  ): EventParticipant[] => (recipients ?? []).flatMap((recipient) => {
    const found = participant(recipient, role)
    return found ? [found] : []
  })
  const from = participant(message.from, 'from')
  return [
    ...(from ? [from] : []),
    ...collect(message.toRecipients, 'to'),
    ...collect(message.ccRecipients, 'cc'),
    ...collect(message.bccRecipients, 'bcc'),
  ]
}

const isoOrEpoch = (value: string | undefined): string => {
  const parsed = value ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString()
}

/**
 * A Graph deletion tombstone identifies only the message, not its conversation.
 * Its canonical key therefore uses the immutable message id for the key's
 * conversation component for both live messages and tombstones, while the
 * event's `conversationId` still retains Graph's real conversation grouping.
 */
const canonicalId = (tenantId: string, messageId: string): string =>
  buildCanonicalMessageId('microsoft', tenantId, messageId, messageId)

const normalizeContent = (message: MicrosoftMessage): Pick<
  NormalizedEvent,
  'contentText'
> => {
  // The delta client asks Graph for text with `Prefer`, but fail closed if a
  // response disregards that preference: raw provider HTML never enters a
  // CommsEvent. `bodyPreview` is Graph's plain-text fallback.
  const content = message.body?.contentType?.toLowerCase() === 'text'
    ? nonEmpty(message.body.content)
    : undefined
  return {
    ...(content ?? nonEmpty(message.bodyPreview)
      ? { contentText: content ?? nonEmpty(message.bodyPreview) }
      : {}),
  }
}

export const normalizeMicrosoftMessage = (
  tenantId: string,
  message: MicrosoftMessage,
): NormalizedEvent => {
  const messageId = nonEmpty(message.id)
  if (!messageId) throw new Error('[comms-microsoft] Graph message carried no id')
  const sender = participant(message.from, 'from')
  const occurredAt = isoOrEpoch(message.receivedDateTime ?? message.sentDateTime)
  const conversationId = nonEmpty(message.conversationId) ?? messageId
  return {
    canonicalMessageId: canonicalId(tenantId, messageId),
    version: 1,
    isDeleted: false,
    ...(message.lastModifiedDateTime
      ? { editedAt: isoOrEpoch(message.lastModifiedDateTime) }
      : {}),
    provider: 'microsoft',
    externalTenantId: tenantId,
    conversationId,
    threadId: conversationId,
    messageId,
    eventType: 'message.created',
    occurredAt,
    senderExternalId: sender?.externalId,
    senderDisplayName: sender?.displayName,
    senderEmail: sender?.email,
    participants: participants(message),
    subject: nonEmpty(message.subject),
    // Graph returns `body.content` as text because every delta request carries
    // Prefer: outlook.body-content-type="text". Do not retain HTML here.
    ...normalizeContent(message),
    attachments: [],
    mentions: [],
    reactions: [],
    visibility: MICROSOFT_MAIL_VISIBILITY,
  }
}

export const normalizeMicrosoftDeletion = (
  tenantId: string,
  messageId: string,
  occurredAt: string,
): NormalizedEvent => ({
  canonicalMessageId: canonicalId(tenantId, messageId),
  version: 1,
  isDeleted: true,
  provider: 'microsoft',
  externalTenantId: tenantId,
  conversationId: messageId,
  threadId: messageId,
  messageId,
  eventType: 'message.deleted',
  occurredAt,
  participants: [],
  attachments: [],
  mentions: [],
  reactions: [],
  visibility: MICROSOFT_MAIL_VISIBILITY,
})
