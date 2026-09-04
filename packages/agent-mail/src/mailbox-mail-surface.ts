import { createHash } from 'node:crypto'

import { ImapError, type ImapSession } from './imap.js'
import { parseInboundEmail } from './mime.js'
import {
  mailboxThreadToken,
  parseMailboxThreadToken,
  type ParsedMailboxThreadToken,
} from './mailbox-thread-token.js'
import {
  DEFAULT_FOLDER,
  MAX_ADDRESS_CHARS,
  MAX_ATTACHMENTS,
  MAX_BODY_CHARS,
  MAX_CONTENT_TYPE_CHARS,
  MAX_CONVERSATION_BODY_CHARS,
  MAX_CONVERSATION_MESSAGES,
  MAX_CONVERSATION_RESPONSE_BYTES,
  MAX_FILENAME_CHARS,
  bounded,
  boundedOptional,
  buildCriteria,
  summarize,
  withImap,
  type MailboxClientOptions,
  type MailboxEndpoints,
  type MailboxMailConversation,
  type MailboxMailThreadPage,
  type MailboxSummary,
} from './mailbox-client.js'

const HEADER_WINDOW_LIMIT = 100

export const mailboxHeaderWindow = (uids: number[], windowOffset: number): number[] =>
  uids.slice(windowOffset, windowOffset + HEADER_WINDOW_LIMIT)

/** Keep every native THREAD group visible before fetching optional older members. */
export const nativeThreadHeaderUids = (groups: number[][]): number[] => {
  const newest = groups.map((group) => Math.max(...group)).filter(Number.isSafeInteger)
  const selected = new Set(newest)
  const remaining = groups.flat().filter((uid) => !selected.has(uid))
    .sort((left, right) => right - left)
  return [...newest, ...remaining].slice(0, HEADER_WINDOW_LIMIT)
}

export type MailboxThreadHeader = MailboxSummary & {
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
): Promise<MailboxThreadHeader> => {
  const parsed = await parseInboundEmail(raw)
  return {
    ...summarize(uid, parsed),
    hasAttachments: parsed.attachments.length > 0,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    snippet: bounded(parsed.snippet, MAX_ADDRESS_CHARS),
    unread: !flags.some((flag) => flag.toUpperCase() === '\\SEEN'),
  }
}

const fetchThreadHeaders = async (session: ImapSession, uids: number[]): Promise<MailboxThreadHeader[]> => {
  const headers: MailboxThreadHeader[] = []
  // A FETCH command retains each response until its tagged completion. Keep the
  // header window in small batches so a hostile header cannot multiply memory.
  for (let start = 0; start < uids.length; start += 20) {
    const batch = await session.fetchMessages(uids.slice(start, start + 20), 'headers')
    for (const message of batch) {
      headers.push(await summarizeThreadHeader(message.uid, message.raw, message.flags))
    }
  }
  return headers
}

const threadHeaders = (
  headers: MailboxThreadHeader[], accountId: string, folder: string, uidValidity: number | null,
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
  const rootOf = (header: MailboxThreadHeader): string | null => {
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
  const groups = new Map<string, { members: MailboxThreadHeader[]; root: string | null }>()
  for (const header of headers) {
    const root = rootOf(header)
    const key = createHash('sha256').update([accountId, root ?? `uid:${header.uid}`].join('\u0000')).digest('base64url')
    const group = groups.get(key) ?? { members: [], root }
    group.members.push(header)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => {
    const members = group.members.sort((left, right) => right.uid - left.uid)
    return {
      id: mailboxThreadToken({
        accountId, folder, memberUids: members.map((member) => member.uid), messageCount: members.length,
        rootMessageId: group.root, uid: members[0]?.uid ?? 0, uidValidity,
      }),
      members,
    }
  })
}

export const validateMailboxThreadMembers = (
  token: ParsedMailboxThreadToken,
  headers: MailboxThreadHeader[],
): MailboxThreadHeader[] | null => {
  const seededGroup = threadHeaders(headers, token.accountId, token.folder, token.uidValidity)
    .find((group) => group.members.some((member) => member.uid === token.seedUid))
  const canonical = seededGroup && parseMailboxThreadToken(seededGroup.id)
  return canonical?.rootDigest === token.rootDigest ? seededGroup.members : null
}

const decodeCursor = (
  cursor: string | undefined,
): { uidValidity: number | null; offset: number; windowOffset: number } | null => {
  if (!cursor) return { offset: 0, uidValidity: null, windowOffset: 0 }
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (!raw || typeof raw !== 'object') return null
    const value = raw as { offset?: unknown; uidValidity?: unknown; windowOffset?: unknown }
    const windowOffset = value.windowOffset === undefined ? 0 : Number(value.windowOffset)
    return Number.isInteger(value.offset) && Number(value.offset) >= 0
      && Number.isInteger(windowOffset) && windowOffset >= 0
      ? {
          offset: Number(value.offset),
          uidValidity: Number.isInteger(value.uidValidity) ? Number(value.uidValidity) : null,
          windowOffset,
        }
      : null
  } catch { return null }
}

const encodeCursor = (
  value: { uidValidity: number | null; offset: number; windowOffset: number },
): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

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
  const uids = nativeGroups ? nativeGroups.flat() : await session.searchUids(criteria)
  const orderedNativeGroups = nativeGroups?.sort(
    (left, right) => Math.max(...right) - Math.max(...left),
  )
  // A fallback page groups the whole bounded header window before slicing.
  // Paging raw UIDs would split one RFC thread across pages and duplicate its token.
  const fallbackUids = orderedNativeGroups ? [] : mailboxHeaderWindow(uids, cursor.windowOffset)
  const initialHeaders = orderedNativeGroups ? [] : await fetchThreadHeaders(
    session, [...new Set(fallbackUids)].sort((left, right) => right - left),
  )
  const fallbackGroups = orderedNativeGroups
    ? []
    : threadHeaders(initialHeaders, input.accountId, folder, selected.uidValidity)
      .sort((left, right) => Math.max(...right.members.map((member) => member.uid))
        - Math.max(...left.members.map((member) => member.uid)))
  const pageUnits = orderedNativeGroups
    ? orderedNativeGroups.slice(cursor.offset, cursor.offset + input.pageSize)
    : fallbackGroups.slice(cursor.offset, cursor.offset + input.pageSize)
      .map((group) => group.members.map((member) => member.uid))
  const pageUids = orderedNativeGroups
    ? nativeThreadHeaderUids(pageUnits)
    : [...new Set(pageUnits.flat())]
      .sort((left, right) => right - left)
      .slice(0, HEADER_WINDOW_LIMIT)
  const headers = orderedNativeGroups
    ? await fetchThreadHeaders(session, pageUids)
    : initialHeaders.filter((header) => pageUids.includes(header.uid))
  const groups: Array<{ id?: string; members: MailboxThreadHeader[]; messageCount: number }> = orderedNativeGroups
    ? pageUnits.map((memberUids) => ({
        members: headers.filter((header) => memberUids.includes(header.uid)),
        messageCount: memberUids.length,
      }))
    : fallbackGroups.slice(cursor.offset, cursor.offset + input.pageSize).map((group) => ({
        ...group,
        members: group.members.filter((member) => pageUids.includes(member.uid)),
        messageCount: group.members.length,
      }))
  const rows = groups.map(({ id, members, messageCount }) => {
    const fallback = members[0]
    const threadId = id ?? (fallback
      ? mailboxThreadToken({
          accountId: input.accountId,
          folder,
          memberUids: members.map((member) => member.uid),
          messageCount,
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
      messageCount,
      receivedAt: newest.date,
      snippet: newest.snippet,
      subject: newest.subject,
      unread: members.some((member) => member.unread),
    } : null
  }).filter((row): row is NonNullable<typeof row> => Boolean(row))
    .sort((left, right) => (right.receivedAt ?? '').localeCompare(left.receivedAt ?? ''))
  const nextOffset = cursor.offset + pageUnits.length
  const totalUnits = orderedNativeGroups?.length ?? fallbackGroups.length
  const nextCursor = nextOffset < totalUnits
    ? encodeCursor({ ...cursor, offset: nextOffset })
    : !orderedNativeGroups && cursor.windowOffset + HEADER_WINDOW_LIMIT < uids.length
      ? encodeCursor({
          offset: 0,
          uidValidity: selected.uidValidity,
          windowOffset: cursor.windowOffset + HEADER_WINDOW_LIMIT,
        })
      : undefined
  return {
    items: rows,
    ...(nextCursor ? { nextCursor } : {}),
  }
})

export const readMailboxMailConversation = async (
  endpoints: MailboxEndpoints,
  input: { accountId: string; folder?: string; threadId: string },
  options: MailboxClientOptions,
): Promise<MailboxMailConversation | null> => withImap(endpoints, options, async (session) => {
  const folder = input.folder?.trim() || DEFAULT_FOLDER
  const selected = await session.selectFolder(folder)
  const token = parseMailboxThreadToken(input.threadId)
  if (!token || token.accountId !== input.accountId || token.folder !== folder
    || token.uidValidity !== selected.uidValidity || !token.memberUids.includes(token.seedUid)) return null
  const headers = await fetchThreadHeaders(session, token.memberUids)
  const validatedMembers = validateMailboxThreadMembers(token, headers)
  if (!validatedMembers) return null
  const messages: MailboxMailConversation['messages'] = []
  let remainingBody = MAX_CONVERSATION_BODY_CHARS
  let remainingResponse = MAX_CONVERSATION_RESPONSE_BYTES
  let responseBounded = false
  for (const member of validatedMembers.sort((left, right) => right.uid - left.uid)
    .slice(0, MAX_CONVERSATION_MESSAGES)) {
    const [fetched] = await session.fetchMessages([member.uid], 'full')
    if (!fetched) continue
    if (fetched.raw.byteLength > remainingResponse) {
      responseBounded = true
      break
    }
    remainingResponse -= fetched.raw.byteLength
    const parsed = await parseInboundEmail(fetched.raw)
    const body = parsed.htmlBody ?? parsed.textBody
    const boundedBody = body.slice(0, Math.min(MAX_BODY_CHARS, remainingBody))
    remainingBody -= boundedBody.length
    messages.push({
      attachments: parsed.attachments.slice(0, MAX_ATTACHMENTS).map((attachment) => ({
        contentType: bounded(attachment.contentType || 'application/octet-stream', MAX_CONTENT_TYPE_CHARS),
        filename: bounded(attachment.filename || 'attachment', MAX_FILENAME_CHARS),
        sizeBytes: attachment.content.byteLength,
      })),
      blockedRemoteContent: parsed.blockedRemoteContent,
      body: boundedBody,
      bodyFormat: parsed.htmlBody ? 'html' : 'text',
      cc: parsed.ccAddresses.map((address) => bounded(address, MAX_ADDRESS_CHARS)).slice(0, 100),
      from: boundedOptional(parsed.fromAddress, MAX_ADDRESS_CHARS),
      id: String(fetched.uid),
      inReplyTo: boundedOptional(parsed.inReplyTo, MAX_ADDRESS_CHARS),
      messageId: boundedOptional(parsed.rfcMessageId, MAX_ADDRESS_CHARS),
      receivedAt: parsed.date?.toISOString() ?? null,
      subject: bounded(parsed.subject, MAX_ADDRESS_CHARS),
      threadId: input.threadId,
      to: parsed.toAddresses.map((address) => bounded(address, MAX_ADDRESS_CHARS)).slice(0, 100),
    })
  }
  return {
    earlierMessagesMayExist: token.messageCount > messages.length || remainingBody === 0 || responseBounded,
    id: input.threadId,
    messages: messages.sort((left, right) => (left.receivedAt ?? '').localeCompare(right.receivedAt ?? '')),
  }
})
