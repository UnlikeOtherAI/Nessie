import {
  buildCanonicalMessageId,
  type EventParticipant,
  type NormalizedEvent,
} from '@nessie/comms-connect'

import {
  buildHeaderIndex,
  collectAttachments,
  extractPlainTextBody,
  type GmailMessage,
} from './mime.js'

/** Personal mailbox messages are only ever visible to the connected user. */
export const GMAIL_VISIBILITY = 'private-mailbox'

/**
 * Split an RFC 5322 address-list header into individual addresses, respecting
 * quoted display names and angle-bracketed addresses so a comma inside
 * `"Doe, Jane" <jane@x.com>` does not split the entry.
 */
const splitAddressList = (value: string): string[] => {
  const out: string[] = []
  let current = ''
  let inQuotes = false
  let inAngle = false
  for (const char of value) {
    if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === '<') {
      inAngle = true
    } else if (char === '>') {
      inAngle = false
    }
    if (char === ',' && !inQuotes && !inAngle) {
      out.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim().length > 0) {
    out.push(current)
  }
  return out
}

type ParsedAddress = { email: string; displayName?: string }

/** Extract `{ email, displayName }` from one `Name <email>` / bare-email token. */
const parseAddress = (raw: string): ParsedAddress | undefined => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return undefined
  }
  const angle = trimmed.match(/<([^>]+)>/)
  if (angle && angle[1]) {
    const email = angle[1].trim()
    const namePart = trimmed.slice(0, angle.index).trim().replace(/^"|"$/g, '').trim()
    return { email, displayName: namePart.length > 0 ? namePart : undefined }
  }
  return { email: trimmed }
}

const parseAddressList = (value: string | undefined): ParsedAddress[] => {
  if (!value) {
    return []
  }
  return splitAddressList(value)
    .map(parseAddress)
    .filter((addr): addr is ParsedAddress => addr !== undefined)
}

const toParticipants = (
  addresses: ParsedAddress[],
  role: EventParticipant['role'],
): EventParticipant[] =>
  addresses.map((addr) => ({
    externalId: addr.email,
    displayName: addr.displayName,
    email: addr.email,
    role,
  }))

const resolveOccurredAt = (
  message: GmailMessage,
  dateHeader: string | undefined,
): string => {
  if (message.internalDate) {
    const ms = Number(message.internalDate)
    if (Number.isFinite(ms)) {
      return new Date(ms).toISOString()
    }
  }
  if (dateHeader) {
    const parsed = Date.parse(dateHeader)
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString()
    }
  }
  return new Date(0).toISOString()
}

/**
 * Map a fully-fetched Gmail message to the provider-agnostic
 * {@link NormalizedEvent}. `emailAddress` is the mailbox identity used as both
 * the canonical-id tenant and the connection's external tenant. Attachments are
 * metadata-only; the body is the decoded text/plain part.
 */
export const normalizeGmailMessage = (
  emailAddress: string,
  message: GmailMessage,
): NormalizedEvent => {
  const headers = buildHeaderIndex(message.payload?.headers)
  const from = parseAddressList(headers.get('from'))
  const to = parseAddressList(headers.get('to'))
  const cc = parseAddressList(headers.get('cc'))
  const sender = from[0]
  const participants = [
    ...toParticipants(from, 'from'),
    ...toParticipants(to, 'to'),
    ...toParticipants(cc, 'cc'),
  ]
  return {
    canonicalMessageId: buildCanonicalMessageId(
      'google',
      emailAddress,
      message.threadId,
      message.id,
    ),
    version: 1,
    isDeleted: false,
    provider: 'google',
    externalTenantId: emailAddress,
    conversationId: message.threadId,
    threadId: message.threadId,
    messageId: message.id,
    eventType: 'message.created',
    occurredAt: resolveOccurredAt(message, headers.get('date')),
    senderExternalId: sender?.email,
    senderDisplayName: sender?.displayName,
    senderEmail: sender?.email,
    participants,
    subject: headers.get('subject'),
    contentText: extractPlainTextBody(message.payload),
    attachments: collectAttachments(message.payload),
    mentions: [],
    reactions: [],
    visibility: GMAIL_VISIBILITY,
  }
}

/**
 * Build the tombstone event for a Gmail `messagesDeleted` history record. The
 * dedupe layer turns this into a new version of the same canonical id (its
 * `isDeleted` flag differs from the stored version) rather than a new message.
 */
export const normalizeGmailDeletion = (
  emailAddress: string,
  ids: { threadId: string; messageId: string },
  occurredAt: string,
): NormalizedEvent => ({
  canonicalMessageId: buildCanonicalMessageId(
    'google',
    emailAddress,
    ids.threadId,
    ids.messageId,
  ),
  version: 1,
  isDeleted: true,
  provider: 'google',
  externalTenantId: emailAddress,
  conversationId: ids.threadId,
  threadId: ids.threadId,
  messageId: ids.messageId,
  eventType: 'message.deleted',
  occurredAt,
  participants: [],
  attachments: [],
  mentions: [],
  reactions: [],
  visibility: GMAIL_VISIBILITY,
})
