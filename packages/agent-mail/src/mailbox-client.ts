import { ImapSession, type ImapPart } from './imap.js'
import { imapAttachmentParts, imapTextParts } from './imap-bodystructure.js'
import { buildOutboundMime, parseInboundEmail, type OutboundEmail } from './mime.js'
import { htmlToText } from './sanitize-html.js'
import { closeSmtpSession, openSmtpSession, sendOverSmtp } from './smtp.js'
import type { DialOptions, MailEndpoint } from './dial.js'

export { mailboxThreadToken } from './mailbox-thread-token.js'
export { listMailboxMailThreads, readMailboxMailConversation } from './mailbox-mail-surface.js'

/** Live mailbox primitives. Provider mail stays with the connected provider. */
export type MailboxEndpoints = {
  imap: MailEndpoint
  smtp: MailEndpoint
  username: string
  password: string
  /** The mailbox's own address; also the SMTP envelope sender and EHLO name. */
  address: string
}

export type MailboxSearchQuery = {
  folder?: string
  from?: string
  subject?: string
  text?: string
  since?: Date
  unseenOnly?: boolean
  limit: number
}

export type MailboxSummary = {
  uid: number
  from: string | null
  fromName: string | null
  to: string[]
  subject: string
  date: string | null
  messageId: string | null
}

export type MailboxMessage = MailboxSummary & {
  cc: string[]
  text: string
  attachments: { filename: string; contentType: string; bytes: number }[]
  truncated: boolean
}

export type MailboxMailThreadPage = {
  items: Array<{
    id: string
    from: string | null
    subject: string
    snippet: string
    receivedAt: string | null
    unread: boolean
    hasAttachments: boolean
    messageCount: number
  }>
  nextCursor?: string
}

export type MailboxMailConversation = {
  id: string
  messages: Array<{
    id: string
    threadId: string
    from: string | null
    to: string[]
    cc: string[]
    subject: string
    receivedAt: string | null
    body: string
    bodyFormat: 'text' | 'html'
    blockedRemoteContent: boolean
    attachments: { filename: string; contentType: string; sizeBytes: number }[]
    messageId: string | null
    inReplyTo: string | null
  }>
  earlierMessagesMayExist: boolean
}

export const DEFAULT_FOLDER = 'INBOX'
export const MAX_BODY_CHARS = 100_000
export const MAX_ATTACHMENTS = 100
export const MAX_ADDRESS_CHARS = 1_000
export const MAX_CONTENT_TYPE_CHARS = 200
export const MAX_FILENAME_CHARS = 500
export const MAX_CONVERSATION_MESSAGES = 200
export const MAX_CONVERSATION_BODY_CHARS = 100_000
// Header literals and individual text sections stay bounded even when a remote
// message contains a huge attachment.
const MAX_CONNECTED_IMAP_LITERAL_BYTES = 1_000_000
const MAX_IMAP_TEXT_SECTION_BYTES = 256 * 1024
export const MAX_CONVERSATION_RESPONSE_BYTES = 2_000_000

export const bounded = (value: string, max: number): string => value.slice(0, max)
export const boundedOptional = (value: string | null, max: number): string | null =>
  value === null ? null : bounded(value, max)

const IMAP_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

const imapDate = (value: Date): string =>
  `${String(value.getUTCDate()).padStart(2, '0')}-${IMAP_MONTHS[value.getUTCMonth()]}-${value.getUTCFullYear()}`

export const buildCriteria = (query: MailboxSearchQuery): ImapPart[] => {
  const parts: ImapPart[] = []
  const push = (keyword: string, value: string | undefined): void => {
    if (!value || value.trim().length === 0) return
    if (parts.length > 0) parts.push(' ')
    parts.push(`${keyword} `, { literal: value })
  }
  if (query.unseenOnly) parts.push('UNSEEN')
  push('FROM', query.from)
  push('SUBJECT', query.subject)
  push('TEXT', query.text)
  if (query.since) {
    if (parts.length > 0) parts.push(' ')
    parts.push(`SINCE ${imapDate(query.since)}`)
  }
  return parts.length > 0 ? parts : ['ALL']
}

export const summarize = (uid: number, parsed: Awaited<ReturnType<typeof parseInboundEmail>>)
: MailboxSummary => ({
  date: parsed.date ? parsed.date.toISOString() : null,
  from: boundedOptional(parsed.fromAddress, MAX_ADDRESS_CHARS),
  fromName: parsed.fromName,
  messageId: boundedOptional(parsed.rfcMessageId, MAX_ADDRESS_CHARS),
  subject: bounded(parsed.subject, MAX_ADDRESS_CHARS),
  to: parsed.toAddresses.map((address) => bounded(address, MAX_ADDRESS_CHARS)).slice(0, 100),
  uid,
})

export type MailboxClientOptions = DialOptions & {
  maxBufferBytes?: number
  /** Server secret used to authenticate opaque list-issued thread tokens. */
  threadTokenSecret?: string
}

export const withImap = async <T>(
  endpoints: MailboxEndpoints,
  options: MailboxClientOptions,
  work: (session: ImapSession) => Promise<T>,
): Promise<T> => {
  const session = await ImapSession.open(
    endpoints.imap,
    { password: endpoints.password, username: endpoints.username },
    {
      ...options,
      maxBufferBytes: Math.min(
        options.maxBufferBytes ?? MAX_CONNECTED_IMAP_LITERAL_BYTES,
        MAX_CONNECTED_IMAP_LITERAL_BYTES,
      ),
    },
  )
  try {
    return await work(session)
  } finally {
    session.close()
  }
}

export const searchMailbox = async (
  endpoints: MailboxEndpoints,
  query: MailboxSearchQuery,
  options: MailboxClientOptions,
): Promise<MailboxSummary[]> => withImap(endpoints, options, async (session) => {
  await session.selectFolder(query.folder?.trim() || DEFAULT_FOLDER)
  const uids = (await session.searchUids(buildCriteria(query))).slice(0, query.limit)
  const fetched = await session.fetchMessages(uids)
  const summaries = await Promise.all(fetched.map(async (message) =>
    summarize(message.uid, await parseInboundEmail(message.raw))))
  const rank = new Map(uids.map((uid, index) => [uid, index]))
  return summaries.sort((left, right) => (rank.get(left.uid) ?? 0) - (rank.get(right.uid) ?? 0))
})

export const readMailboxMessage = async (
  endpoints: MailboxEndpoints,
  input: { uid: number; folder?: string },
  options: MailboxClientOptions,
): Promise<MailboxMessage | null> => withImap(endpoints, options, async (session) => {
  await session.selectFolder(input.folder?.trim() || DEFAULT_FOLDER)
  const [fetched] = await session.fetchMessages([input.uid])
  if (!fetched) return null
  const parsed = await parseInboundEmail(fetched.raw)
  const textPart = imapTextParts(fetched.bodyStructure).find((part) => part.textKind === 'plain')
    ?? imapTextParts(fetched.bodyStructure).find((part) => part.textKind === 'html')
  const payload = textPart
    ? await session.fetchBodySection(fetched.uid, textPart.section, MAX_IMAP_TEXT_SECTION_BYTES)
    : null
  const decoded = payload && textPart ? decodeImapTextPart(payload, textPart.encoding) : Buffer.alloc(0)
  const text = textPart?.textKind === 'html'
    ? htmlToText(decodeImapText(decoded, textPart.charset))
    : decodeImapText(decoded, textPart?.charset ?? null)
  const truncated = text.length > MAX_BODY_CHARS
    || payload?.byteLength === MAX_IMAP_TEXT_SECTION_BYTES
  return {
    ...summarize(fetched.uid, parsed),
    attachments: imapAttachmentParts(fetched.bodyStructure).map((attachment) => ({
      bytes: attachment.bytes,
      contentType: attachment.contentType,
      filename: attachment.filename ?? 'attachment',
    })),
    cc: parsed.ccAddresses,
    text: text.slice(0, MAX_BODY_CHARS),
    truncated,
  }
})

const decodeImapTextPart = (input: Buffer, encoding: string | null): Buffer => {
  const normalized = encoding?.toUpperCase()
  if (normalized === 'BASE64') return Buffer.from(input.toString('ascii').replace(/\s/g, ''), 'base64')
  if (normalized !== 'QUOTED-PRINTABLE') return input
  const value = input.toString('latin1').replace(/=\r?\n/g, '')
  const bytes: number[] = []
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '=' && /^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16))
      index += 2
    } else bytes.push(value.charCodeAt(index))
  }
  return Buffer.from(bytes)
}

const decodeImapText = (input: Buffer, charset: string | null): string => {
  try {
    return new TextDecoder(charset?.trim() || 'utf-8', { fatal: false }).decode(input)
  } catch {
    return input.toString('utf8')
  }
}

export const sendFromMailbox = async (
  endpoints: MailboxEndpoints,
  email: Omit<OutboundEmail, 'fromAddress'>,
  options: MailboxClientOptions,
): Promise<void> => {
  const session = await openSmtpSession(
    endpoints.smtp,
    { password: endpoints.password, username: endpoints.username },
    { ...options, clientName: endpoints.address.split('@')[1] ?? 'localhost' },
  )
  try {
    await sendOverSmtp(session, {
      from: endpoints.address,
      mime: buildOutboundMime({ ...email, fromAddress: endpoints.address }),
      recipients: [...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])],
    })
  } finally {
    closeSmtpSession(session)
  }
}

export const testMailboxConnection = async (
  endpoints: MailboxEndpoints,
  options: MailboxClientOptions,
): Promise<{ folder: string; messagesVisible: number }> => {
  const messagesVisible = await withImap(endpoints, options, async (session) => {
    await session.selectFolder(DEFAULT_FOLDER)
    return (await session.searchUids(['ALL'])).length
  })
  const smtp = await openSmtpSession(
    endpoints.smtp,
    { password: endpoints.password, username: endpoints.username },
    { ...options, clientName: endpoints.address.split('@')[1] ?? 'localhost' },
  )
  closeSmtpSession(smtp)
  return { folder: DEFAULT_FOLDER, messagesVisible }
}
