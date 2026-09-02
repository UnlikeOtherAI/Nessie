import { ImapSession, type ImapPart } from './imap.js'
import { buildOutboundMime, parseInboundEmail, type OutboundEmail } from './mime.js'
import { closeSmtpSession, openSmtpSession, sendOverSmtp } from './smtp.js'
import type { DialOptions, MailEndpoint } from './dial.js'

/**
 * The three things an agent does with a connected mailbox: look, read, write.
 *
 * Everything runs **live** against IMAP and SMTP. Nothing is imported into the
 * `CommsEvent` store and no copy of the mail is kept — the provider holds the
 * mailbox, which is the whole difference between this and a hosted one. A
 * question about last Tuesday must not depend on whether a sync ran.
 */

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

const DEFAULT_FOLDER = 'INBOX'
const MAX_BODY_CHARS = 20_000

const IMAP_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/** IMAP's own date form. Built from a parsed Date, so it is never model text. */
const imapDate = (value: Date): string =>
  `${String(value.getUTCDate()).padStart(2, '0')}-${
    IMAP_MONTHS[value.getUTCMonth()]}-${value.getUTCFullYear()}`

const buildCriteria = (query: MailboxSearchQuery): ImapPart[] => {
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

const summarize = (uid: number, parsed: Awaited<ReturnType<typeof parseInboundEmail>>)
: MailboxSummary => ({
  date: parsed.date ? parsed.date.toISOString() : null,
  from: parsed.fromAddress,
  fromName: parsed.fromName,
  messageId: parsed.rfcMessageId,
  subject: parsed.subject,
  to: parsed.toAddresses,
  uid,
})

export type MailboxClientOptions = DialOptions & { maxBufferBytes?: number }

const withImap = async <T>(
  endpoints: MailboxEndpoints,
  options: MailboxClientOptions,
  work: (session: ImapSession) => Promise<T>,
): Promise<T> => {
  const session = await ImapSession.open(
    endpoints.imap,
    { password: endpoints.password, username: endpoints.username },
    options,
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
): Promise<MailboxSummary[]> =>
  withImap(endpoints, options, async (session) => {
    await session.selectFolder(query.folder?.trim() || DEFAULT_FOLDER)
    const uids = (await session.searchUids(buildCriteria(query))).slice(0, query.limit)
    const fetched = await session.fetchMessages(uids, 'headers')
    const summaries = await Promise.all(
      fetched.map(async (message) => summarize(message.uid, await parseInboundEmail(message.raw))),
    )
    // IMAP returns FETCH results in the server's own order; the caller asked
    // for newest first, so the ordering is restored from the UID sequence.
    const rank = new Map(uids.map((uid, index) => [uid, index]))
    return summaries.sort((a, b) => (rank.get(a.uid) ?? 0) - (rank.get(b.uid) ?? 0))
  })

export const readMailboxMessage = async (
  endpoints: MailboxEndpoints,
  input: { uid: number; folder?: string },
  options: MailboxClientOptions,
): Promise<MailboxMessage | null> =>
  withImap(endpoints, options, async (session) => {
    await session.selectFolder(input.folder?.trim() || DEFAULT_FOLDER)
    const [fetched] = await session.fetchMessages([input.uid], 'full')
    if (!fetched) return null
    const parsed = await parseInboundEmail(fetched.raw)
    const truncated = parsed.textBody.length > MAX_BODY_CHARS
    return {
      ...summarize(fetched.uid, parsed),
      attachments: parsed.attachments.map((attachment) => ({
        bytes: attachment.content.byteLength,
        contentType: attachment.contentType,
        filename: attachment.filename,
      })),
      cc: parsed.ccAddresses,
      text: truncated ? parsed.textBody.slice(0, MAX_BODY_CHARS) : parsed.textBody,
      truncated,
    }
  })

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

/**
 * Prove both legs work before a connection row is written.
 *
 * Both, not one: a connection that can read but cannot send is a mailbox an
 * agent will fail at halfway through a task, and the failure would surface as a
 * refusal to a person who was told the mailbox was connected.
 */
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
