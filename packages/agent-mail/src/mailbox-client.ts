import { createHash } from 'node:crypto'

import { ImapError, ImapSession, type ImapPart } from './imap.js'
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
    inReplyTo: string | null
  }>
  earlierMessagesMayExist: boolean
}

const DEFAULT_FOLDER = 'INBOX'
const MAX_BODY_CHARS = 20_000
const HEADER_WINDOW_LIMIT = 100

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

type ThreadHeader = MailboxSummary & {
  inReplyTo: string | null
  references: string[]
  snippet: string
  hasAttachments: boolean
  unread: boolean
}

const summarizeThreadHeader = async (
  uid: number,
  raw: Buffer,
  flags: readonly string[],
): Promise<ThreadHeader> => {
  const parsed = await parseInboundEmail(raw)
  return {
    ...summarize(uid, parsed),
    hasAttachments: parsed.attachments.length > 0,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    snippet: parsed.snippet,
    unread: !flags.some((flag) => flag.toUpperCase() === '\\SEEN'),
  }
}

/** Stable opaque id for a structural conversation; no mailbox content is stored. */
export const mailboxThreadToken = (input: {
  accountId: string
  folder: string
  uidValidity: number | null
  rootMessageId: string | null
  uid: number
}): string => createHash('sha256').update([
  input.accountId,
  input.rootMessageId ?? [
    'folder', input.folder, 'uidvalidity', input.uidValidity ?? 'unknown', 'uid', input.uid,
  ].join(':'),
].join('\u0000')).digest('base64url')

const threadHeaders = (
  headers: ThreadHeader[], accountId: string, folder: string, uidValidity: number | null,
) => {
  const parent = new Map<string, string>()
  const byMessageId = new Map(headers.flatMap((header) =>
    header.messageId ? [[header.messageId, header.messageId] as const] : []))
  for (const header of headers) {
    if (!header.messageId) continue
    const candidate = [header.inReplyTo, ...header.references].reverse()
      .find((id): id is string => Boolean(id && byMessageId.has(id)))
    if (candidate) parent.set(header.messageId, candidate)
  }
  const rootOf = (header: ThreadHeader): string | null => {
    // References are normalized by parseInboundEmail. The first is the
    // structural root even when this bounded window does not include it.
    let root = header.references[0] ?? header.inReplyTo ?? header.messageId
    const visited = new Set<string>()
    while (root && parent.has(root) && !visited.has(root)) {
      visited.add(root)
      root = parent.get(root) ?? null
    }
    return root
  }
  const groups = new Map<string, ThreadHeader[]>()
  for (const header of headers) {
    const root = rootOf(header)
    const id = mailboxThreadToken({
      accountId, folder, rootMessageId: root, uid: header.uid, uidValidity,
    })
    const group = groups.get(id) ?? []
    group.push(header)
    groups.set(id, group)
  }
  return [...groups.entries()].map(([id, members]) => ({ id, members }))
}

const decodeCursor = (cursor: string | undefined): { uidValidity: number | null; offset: number } | null => {
  if (!cursor) return { offset: 0, uidValidity: null }
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (!raw || typeof raw !== 'object') return null
    const value = raw as { offset?: unknown; uidValidity?: unknown }
    return Number.isInteger(value.offset) && Number(value.offset) >= 0
      ? {
          offset: Number(value.offset),
          uidValidity: Number.isInteger(value.uidValidity) ? Number(value.uidValidity) : null,
        }
      : null
  } catch {
    return null
  }
}

const encodeCursor = (value: { uidValidity: number | null; offset: number }): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

/**
 * Live IMAP list with a bounded header window. Subject equality never creates
 * a thread: only Message-ID reference structure may join messages.
 */
export const listMailboxMailThreads = async (
  endpoints: MailboxEndpoints,
  input: {
    accountId: string
    cursor?: string
    folder?: string
    pageSize: number
    query?: string
    unreadOnly?: boolean
  },
  options: MailboxClientOptions,
): Promise<MailboxMailThreadPage> => withImap(endpoints, options, async (session) => {
  const folder = input.folder?.trim() || DEFAULT_FOLDER
  const selected = await session.selectFolder(folder)
  const cursor = decodeCursor(input.cursor)
  if (!cursor || (cursor.uidValidity !== null && cursor.uidValidity !== selected.uidValidity)) {
    throw new ImapError('The mailbox folder changed; refresh the list.', 'not_found')
  }
  const criteria = buildCriteria({
    from: undefined,
    limit: HEADER_WINDOW_LIMIT,
    since: undefined,
    subject: undefined,
    text: input.query,
    unseenOnly: input.unreadOnly,
  })
  const capabilities = await session.capabilities()
  const nativeGroups = capabilities.has('THREAD=REFERENCES')
    ? await session.threadReferencesUids(criteria)
    : null
  const uids = nativeGroups
    ? nativeGroups.flat()
    : await session.searchUids(criteria)
  const pageUnits = nativeGroups
    ? nativeGroups.slice(cursor.offset, cursor.offset + input.pageSize)
    : uids.slice(cursor.offset, cursor.offset + input.pageSize).map((uid) => [uid])
  const pageUids = [...new Set(pageUnits.flat())].slice(0, HEADER_WINDOW_LIMIT)
  const fetched = await session.fetchMessages(pageUids, 'headers')
  const headers = await Promise.all(fetched.map((message) =>
    summarizeThreadHeader(message.uid, message.raw, message.flags)))
  const groups: Array<{ id?: string; members: ThreadHeader[] }> = nativeGroups
    ? pageUnits.map((uids) => ({
        members: headers.filter((header) => uids.includes(header.uid)),
      }))
    : threadHeaders(headers, input.accountId, folder, selected.uidValidity)
  const rows = groups
    .map(({ id, members }) => {
      const fallback = members[0]
      const threadId = id ?? (fallback
        ? mailboxThreadToken({
            accountId: input.accountId,
            folder,
            rootMessageId: fallback.references[0] ?? fallback.inReplyTo ?? fallback.messageId,
            uid: fallback.uid,
            uidValidity: selected.uidValidity,
          })
        : null)
      const newest = [...members].sort((left, right) => right.uid - left.uid)[0]
      return newest && threadId ? {
        from: newest.from,
        hasAttachments: members.some((member) => member.hasAttachments),
        id: threadId,
        messageCount: members.length,
        receivedAt: newest.date,
        snippet: newest.snippet,
        subject: newest.subject,
        unread: newest.unread,
      } : null
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .sort((left, right) => (right.receivedAt ?? '').localeCompare(left.receivedAt ?? ''))
  const nextOffset = cursor.offset + pageUnits.length
  const totalUnits = nativeGroups?.length ?? uids.length
  return {
    items: rows,
    ...(nextOffset < totalUnits
      ? { nextCursor: encodeCursor({ offset: nextOffset, uidValidity: selected.uidValidity }) }
      : {}),
  }
})

/** Read a bounded, structurally identified IMAP conversation without persisting it. */
export const readMailboxMailConversation = async (
  endpoints: MailboxEndpoints,
  input: { accountId: string; folder?: string; threadId: string },
  options: MailboxClientOptions,
): Promise<MailboxMailConversation | null> => withImap(endpoints, options, async (session) => {
  const folder = input.folder?.trim() || DEFAULT_FOLDER
  const selected = await session.selectFolder(folder)
  const uids = (await session.searchUids(['ALL'])).slice(0, HEADER_WINDOW_LIMIT)
  const headers = await Promise.all((await session.fetchMessages(uids, 'headers'))
    .map((message) => summarizeThreadHeader(message.uid, message.raw, message.flags)))
  const group = threadHeaders(headers, input.accountId, folder, selected.uidValidity)
    .find((candidate) => candidate.id === input.threadId)
  if (!group) return null
  const full = await session.fetchMessages(group.members.map((member) => member.uid), 'full')
  const messages = await Promise.all(full.map(async (fetched) => {
    const parsed = await parseInboundEmail(fetched.raw)
    const body = parsed.htmlBody ?? parsed.textBody
    const bodyFormat: 'html' | 'text' = parsed.htmlBody ? 'html' : 'text'
    return {
      attachments: parsed.attachments.map((attachment) => ({
        contentType: attachment.contentType,
        filename: attachment.filename,
        sizeBytes: attachment.content.byteLength,
      })),
      blockedRemoteContent: parsed.blockedRemoteContent,
      body: body.slice(0, MAX_BODY_CHARS),
      bodyFormat,
      cc: parsed.ccAddresses,
      from: parsed.fromAddress,
      id: String(fetched.uid),
      inReplyTo: parsed.inReplyTo,
      receivedAt: parsed.date?.toISOString() ?? null,
      subject: parsed.subject,
      threadId: input.threadId,
      to: parsed.toAddresses,
    }
  }))
  return {
    earlierMessagesMayExist: uids.length === HEADER_WINDOW_LIMIT,
    id: input.threadId,
    messages: messages.sort((left, right) => (left.receivedAt ?? '').localeCompare(right.receivedAt ?? '')),
  }
})

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
