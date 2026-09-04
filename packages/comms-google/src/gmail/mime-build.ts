/**
 * Outbound RFC 5322 message construction.
 *
 * Kept separate from `mime.ts`, which parses what Gmail returns; the two
 * directions share no code and conflating them made the read path harder to
 * follow. Everything here is pure — no fetch, no credentials — so header
 * injection and encoding are unit-testable without a network.
 */

/** A composed message, before it becomes a draft or a send. */
export type OutboundMessage = {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  /** Plain-text body. Markdown is sent as-is; Gmail renders it literally. */
  body: string
  /** Optional HTML alternative. When present the message is multipart/alternative. */
  bodyHtml?: string
  /** RFC 5322 `In-Reply-To` / `References` for a reply into an existing thread. */
  inReplyTo?: string
  references?: string[]
  attachments?: OutboundAttachment[]
}

export type OutboundAttachment = {
  filename: string
  mimeType: string
  /** Raw bytes. The caller has already proved access and applied size limits. */
  content: Buffer
}

/**
 * Server-only identity of an attachment Gmail returned in a stored draft.
 *
 * Gmail usually supplies an immutable `attachmentId`; a small inline part can
 * instead carry its bytes directly, in which case the caller supplies a hash
 * of those bytes. Neither identifier is a card or API payload — it exists only
 * to bind an approval to the exact provider content that will be sent.
 */
export type GmailDraftAttachmentIdentity = {
  attachmentId?: string
  inlineDataHash?: string
  filename: string
  mimeType: string
  sizeBytes: number
}

export class MimeBuildError extends Error {
  constructor(reason: string) {
    super(`[comms-google] cannot build message: ${reason}`)
    this.name = 'MimeBuildError'
  }
}

/**
 * A header value may not contain CR or LF. Without this check a subject
 * carrying "\r\nBcc: someone@evil.test" would inject a real header and silently
 * add a recipient — the classic email header-injection bug, and the model
 * writes these values.
 */
const assertHeaderSafe = (label: string, value: string): void => {
  if (/[\r\n]/.test(value)) {
    throw new MimeBuildError(`${label} may not contain a line break`)
  }
}

/** Emit one canonical RFC Message-ID pair, never a caller's nested brackets. */
const formatMessageId = (label: string, value: string): string => {
  assertHeaderSafe(label, value)
  const bare = value.trim().replace(/^<+/, '').replace(/>+$/, '')
  if (!bare || /[<>\s]/.test(bare)) {
    throw new MimeBuildError(`${label} contains an invalid Message-ID`)
  }
  return `<${bare}>`
}

// Deliberately permissive: full RFC 5322 addressing is not worth reimplementing,
// and Gmail rejects what it dislikes. This only rules out the shapes that would
// corrupt the envelope or inject a header.
const ADDRESS_PATTERN = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/

const normalizeAddresses = (label: string, values: readonly string[]): string[] => {
  const seen = new Set<string>()
  for (const raw of values) {
    const value = raw.trim()
    assertHeaderSafe(label, value)
    if (!ADDRESS_PATTERN.test(value)) {
      throw new MimeBuildError(`${label} contains an invalid address: ${value}`)
    }
    seen.add(value)
  }
  return [...seen]
}

/**
 * Encode a header value that may contain non-ASCII, per RFC 2047. A subject in
 * Czech or Japanese is ordinary, not an edge case.
 */
const encodeHeaderValue = (value: string): string =>
  /^[\x20-\x7E]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`

const foldBase64 = (base64: string): string =>
  (base64.match(/.{1,76}/g) ?? []).join('\r\n')

const randomBoundary = (seed: string, index: number): string =>
  `----nessie-${seed}-${index}`

const bodyPart = (message: OutboundMessage): string[] => {
  const text = [
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    foldBase64(Buffer.from(message.body, 'utf8').toString('base64')),
  ]
  if (!message.bodyHtml) {
    return text
  }
  const boundary = randomBoundary('alt', 1)
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    ...text,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    foldBase64(Buffer.from(message.bodyHtml, 'utf8').toString('base64')),
    `--${boundary}--`,
  ]
}

/**
 * Build the RFC 5322 message and return it base64url-encoded, which is the
 * shape Gmail's `raw` field takes.
 *
 * No `From` header: Gmail sets it from the authenticated account, and letting a
 * caller name a sender is how you end up sending as someone else.
 */
export const buildRawMessage = (message: OutboundMessage): string => {
  const to = normalizeAddresses('To', message.to)
  if (to.length === 0) {
    throw new MimeBuildError('at least one recipient is required')
  }
  const cc = normalizeAddresses('Cc', message.cc ?? [])
  const bcc = normalizeAddresses('Bcc', message.bcc ?? [])
  assertHeaderSafe('Subject', message.subject)

  const headers: string[] = [
    `To: ${to.join(', ')}`,
    ...(cc.length > 0 ? [`Cc: ${cc.join(', ')}`] : []),
    ...(bcc.length > 0 ? [`Bcc: ${bcc.join(', ')}`] : []),
    `Subject: ${encodeHeaderValue(message.subject)}`,
    'MIME-Version: 1.0',
  ]
  if (message.inReplyTo) {
    headers.push(`In-Reply-To: ${formatMessageId('In-Reply-To', message.inReplyTo)}`)
  }
  if (message.references && message.references.length > 0) {
    headers.push(`References: ${message.references.map((reference) => formatMessageId('References', reference)).join(' ')}`)
  }

  const attachments = message.attachments ?? []
  const lines: string[] =
    attachments.length === 0
      ? [...headers, ...bodyPart(message)]
      : (() => {
          const boundary = randomBoundary('mixed', 0)
          const parts: string[] = [
            ...headers,
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            '',
            `--${boundary}`,
            ...bodyPart(message),
          ]
          for (const attachment of attachments) {
            assertHeaderSafe('Attachment filename', attachment.filename)
            assertHeaderSafe('Attachment type', attachment.mimeType)
            parts.push(
              `--${boundary}`,
              `Content-Type: ${attachment.mimeType}; name="${encodeHeaderValue(attachment.filename)}"`,
              `Content-Disposition: attachment; filename="${encodeHeaderValue(attachment.filename)}"`,
              'Content-Transfer-Encoding: base64',
              '',
              foldBase64(attachment.content.toString('base64')),
            )
          }
          parts.push(`--${boundary}--`)
          return parts
        })()

  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url')
}

/**
 * The canonical fingerprint of a draft's content.
 *
 * This is what an approval binds to. Hashing the draft *id* would prove
 * nothing — the draft stays mutable through the card's Edit button, Gmail
 * itself, or another run — so the send path re-reads the draft and compares
 * this before dispatching. Recipient order and case must not change the value,
 * or an innocent re-render would invalidate a live approval.
 */
export const canonicalDraftFingerprintInput = (message: {
  to: readonly string[]
  cc?: readonly string[]
  bcc?: readonly string[]
  subject: string
  body: string
  inReplyTo?: string
  references?: readonly string[]
  threadId?: string
  attachmentIds?: readonly string[]
  attachmentIdentities?: readonly GmailDraftAttachmentIdentity[]
}): string => {
  const addresses = (values: readonly string[] | undefined): string[] =>
    [...new Set((values ?? []).map((value) => value.trim().toLowerCase()))].sort()
  const attachments = (message.attachmentIdentities ?? [])
    .map((attachment) => JSON.stringify({
      attachmentId: attachment.attachmentId ?? null,
      inlineDataHash: attachment.inlineDataHash ?? null,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    }))
    .sort()
  return JSON.stringify({
    to: addresses(message.to),
    cc: addresses(message.cc),
    bcc: addresses(message.bcc),
    subject: message.subject.trim(),
    body: message.body,
    inReplyTo: message.inReplyTo?.trim() ?? '',
    references: (message.references ?? []).map((value) => value.trim()),
    threadId: message.threadId ?? '',
    attachmentIds: [...(message.attachmentIds ?? [])].sort(),
    attachments,
  })
}
