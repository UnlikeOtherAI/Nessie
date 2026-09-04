import { createHash } from 'node:crypto'

import { ImapError, type ImapSession } from './imap.js'
import { imapAttachmentParts, imapTextParts, type ImapBodyPart } from './imap-bodystructure.js'
import { uidWindowEndingAt, withinUidWindow } from './imap-uid-window.js'
import { parseInboundEmail } from './mime.js'
import { sanitizeEmailHtml } from './sanitize-html.js'
import {
  mailboxThreadToken,
  mailboxThreadRootDigest,
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
const MAX_TEXT_SECTION_BYTES = 256 * 1024
/** The open reader never asks IMAP to identify or fetch an unbounded thread. */
const MAX_THREAD_DETAIL_UIDS = 500
const MAX_THREAD_DISCOVERY_WINDOWS = 20

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

/** The first UID in an RFC 5256 group is its stable root/seed. */
export const nativeThreadSeedUids = (groups: number[][]): number[] =>
  groups.flatMap((group) => group[0] === undefined ? [] : [group[0]])
    .filter((uid): uid is number => Number.isSafeInteger(uid) && uid > 0)

/** Keep a stable seed available for authentication without widening the detail read. */
export const boundedThreadDetailUids = (uids: number[], seedUid: number): number[] => {
  const newest = [...new Set(uids)].sort((left, right) => right - left)
  const bounded = newest.slice(0, MAX_THREAD_DETAIL_UIDS)
  if (!bounded.includes(seedUid) && Number.isSafeInteger(seedUid) && seedUid > 0) {
    bounded[MAX_THREAD_DETAIL_UIDS - 1] = seedUid
  }
  return [...new Set(bounded)]
}

export type MailboxThreadHeader = MailboxSummary & {
  bodyStructure?: ImapBodyPart[]
  cc: string[]
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
  bodyStructure: ImapBodyPart[],
): Promise<MailboxThreadHeader> => {
  const parsed = await parseInboundEmail(raw)
  return {
    ...summarize(uid, parsed),
    bodyStructure,
    cc: parsed.ccAddresses.map((address) => bounded(address, MAX_ADDRESS_CHARS)).slice(0, 100),
    hasAttachments: imapAttachmentParts(bodyStructure).length > 0,
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
    const batch = await session.fetchMessages(uids.slice(start, start + 20))
    for (const message of batch) {
      headers.push(await summarizeThreadHeader(
        message.uid, message.raw, message.flags, message.bodyStructure,
      ))
    }
  }
  return headers
}

const threadHeaders = (
  headers: MailboxThreadHeader[], accountId: string, folder: string, uidValidity: number | null,
  tokenSecret: string,
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
    const seed = members.find((member) => member.messageId === group.root)
      ?? [...members].sort((left, right) => left.uid - right.uid)[0]
    return {
      id: mailboxThreadToken({
        accountId, folder, rootMessageId: group.root, uid: seed?.uid ?? 0, uidValidity,
      }, tokenSecret),
      members,
      root: group.root,
    }
  })
}

const stableFallbackSeed = (
  group: { members: MailboxThreadHeader[]; root: string | null },
): MailboxThreadHeader | null => {
  const presentRoot = group.members.find((member) => member.messageId === group.root)
  if (presentRoot) return presentRoot
  // Never turn a bounded list window into an unbounded Message-ID search. A
  // visible member remains a signed seed; its structural root stays in the
  // token digest and is re-derived from its live References on open.
  return [...group.members].sort((left, right) => left.uid - right.uid)[0] ?? null
}

export const validateMailboxThreadMembers = (
  token: ParsedMailboxThreadToken,
  headers: MailboxThreadHeader[],
  tokenSecret: string,
): MailboxThreadHeader[] | null => {
  const seededGroup = threadHeaders(headers, token.accountId, token.folder, token.uidValidity, tokenSecret)
    .find((group) => group.members.some((member) => member.uid === token.seedUid))
  if (!seededGroup) return null
  const seed = seededGroup.members.find((member) => member.uid === token.seedUid)
  return seed && mailboxThreadRootDigest({
    rootMessageId: seededGroup.root,
    uid: token.seedUid,
    uidValidity: token.uidValidity,
  }) === token.rootDigest ? seededGroup.members : null
}

const decodeCursor = (
  cursor: string | undefined,
): { uidValidity: number | null; offset: number; windowUpper: number | null } | null => {
  if (!cursor) return { offset: 0, uidValidity: null, windowUpper: null }
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (!raw || typeof raw !== 'object') return null
    const value = raw as { offset?: unknown; uidValidity?: unknown; windowUpper?: unknown }
    const windowUpper = value.windowUpper === undefined ? null : Number(value.windowUpper)
    return Number.isInteger(value.offset) && Number(value.offset) >= 0
      && (windowUpper === null || (Number.isSafeInteger(windowUpper) && windowUpper >= 0))
      ? {
          offset: Number(value.offset),
          uidValidity: Number.isInteger(value.uidValidity) ? Number(value.uidValidity) : null,
          windowUpper,
        }
      : null
  } catch { return null }
}

const encodeCursor = (
  value: { uidValidity: number | null; offset: number; windowUpper: number },
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
  const tokenSecret = options.threadTokenSecret
  if (!tokenSecret) throw new ImapError('Mailbox thread tokens are not configured.', 'protocol')
  const folder = input.folder?.trim() || DEFAULT_FOLDER
  const selected = await session.selectFolder(folder)
  const cursor = decodeCursor(input.cursor)
  if (!cursor || (cursor.uidValidity !== null && cursor.uidValidity !== selected.uidValidity)) {
    throw new ImapError('The mailbox folder changed; refresh the list.', 'not_found')
  }
  if (selected.uidNext === null) {
    throw new ImapError('The mail server did not provide a safe mailbox UID window.', 'protocol')
  }
  const window = uidWindowEndingAt(cursor.windowUpper ?? selected.uidNext - 1)
  if (!window) return { items: [] }
  const criteria = buildCriteria({
    from: undefined,
    limit: HEADER_WINDOW_LIMIT,
    since: undefined,
    subject: undefined,
    text: input.query,
    unseenOnly: input.unreadOnly,
  })
  // Never ask a provider for every UID in a mailbox. A structural group may
  // reappear in an older window, but its root-authenticated token stays safe
  // and the reader says when its bounded view might omit earlier mail.
  const headers = await fetchThreadHeaders(session, await session.searchUids(withinUidWindow(criteria, window)))
  const groups = threadHeaders(headers, input.accountId, folder, selected.uidValidity, tokenSecret)
    .sort((left, right) => Math.max(...right.members.map((member) => member.uid))
      - Math.max(...left.members.map((member) => member.uid)))
  const pageGroups = await Promise.all(groups.slice(cursor.offset, cursor.offset + input.pageSize)
    .map((group) => {
      const seed = stableFallbackSeed(group)
      return seed ? {
        ...group,
        id: mailboxThreadToken({
          accountId: input.accountId, folder, rootMessageId: group.root,
          uid: seed.uid, uidValidity: selected.uidValidity,
        }, tokenSecret),
      } : null
    }))
  const rows = pageGroups.map((group) => {
    if (!group) return null
    const newest = group.members[0]
    return newest ? {
      from: newest.from,
      hasAttachments: group.members.some((member) => member.hasAttachments),
      id: group.id,
      messageCount: group.members.length,
      receivedAt: newest.date,
      snippet: newest.snippet,
      subject: newest.subject,
      unread: group.members.some((member) => member.unread),
    } : null
  }).filter((row): row is NonNullable<typeof row> => Boolean(row))
    .sort((left, right) => (right.receivedAt ?? '').localeCompare(left.receivedAt ?? ''))
  const nextOffset = cursor.offset + pageGroups.length
  const nextCursor = nextOffset < groups.length
    ? encodeCursor({ offset: nextOffset, uidValidity: selected.uidValidity, windowUpper: window.upper })
    : window.lower > 1
      ? encodeCursor({
          offset: 0,
          uidValidity: selected.uidValidity,
          windowUpper: window.lower - 1,
        })
      : undefined
  return {
    items: rows,
    ...(nextCursor ? { nextCursor } : {}),
  }
})

const decodedPart = (input: Buffer, encoding: string | null): Buffer => {
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

const textFromPart = (input: Buffer, charset: string | null): string => {
  try {
    return new TextDecoder(charset?.trim() || 'utf-8', { fatal: false }).decode(input)
  } catch {
    return input.toString('utf8')
  }
}

const messageAttachments = (parts: readonly ImapBodyPart[]) => imapAttachmentParts(parts)
  .slice(0, MAX_ATTACHMENTS)
  .map((part) => ({
    contentType: bounded(part.contentType || 'application/octet-stream', MAX_CONTENT_TYPE_CHARS),
    filename: bounded(part.filename || 'attachment', MAX_FILENAME_CHARS),
    sizeBytes: part.bytes,
  }))

const preferredTextPart = (parts: readonly ImapBodyPart[]): ImapBodyPart | null =>
  imapTextParts(parts).find((part) => part.textKind === 'html')
  ?? imapTextParts(parts).find((part) => part.textKind === 'plain')
  ?? null

export const discoverRelatedThreadUids = async (
  session: ImapSession,
  rootMessageId: string,
  uidNext: number,
): Promise<{ capped: boolean; uids: number[] }> => {
  const uids = new Set<number>()
  let upper = uidNext - 1
  let windows = 0
  while (upper > 0 && windows < MAX_THREAD_DISCOVERY_WINDOWS && uids.size < MAX_THREAD_DETAIL_UIDS) {
    const window = uidWindowEndingAt(upper)
    if (!window) break
    // References normally retains the structural root for every reply; the
    // In-Reply-To branch covers the first reply when it has no References field.
    const criteria = withinUidWindow([
      'OR HEADER MESSAGE-ID ', { literal: rootMessageId }, ' OR HEADER REFERENCES ', { literal: rootMessageId },
      ' HEADER IN-REPLY-TO ', { literal: rootMessageId },
    ], window)
    for (const uid of await session.searchUids(criteria)) uids.add(uid)
    upper = window.lower - 1
    windows += 1
  }
  return { capped: upper > 0, uids: [...uids] }
}

export const readMailboxMailConversation = async (
  endpoints: MailboxEndpoints,
  input: { accountId: string; folder?: string; threadId: string },
  options: MailboxClientOptions,
): Promise<MailboxMailConversation | null> => withImap(endpoints, options, async (session) => {
  const folder = input.folder?.trim() || DEFAULT_FOLDER
  const selected = await session.selectFolder(folder)
  const token = parseMailboxThreadToken(input.threadId, {
    accountId: input.accountId,
    folder,
    secret: options.threadTokenSecret ?? '',
  })
  if (!token || token.uidValidity !== selected.uidValidity) return null
  if (selected.uidNext === null) return null
  const [seed] = await fetchThreadHeaders(session, [token.seedUid])
  if (!seed || mailboxThreadRootDigest({
    rootMessageId: seed.references[0] ?? seed.inReplyTo ?? seed.messageId,
    uid: token.seedUid,
    uidValidity: selected.uidValidity,
  }) !== token.rootDigest) return null
  const rootMessageId = seed.references[0] ?? seed.inReplyTo ?? seed.messageId
  const discovered = rootMessageId ? await discoverRelatedThreadUids(session, rootMessageId, selected.uidNext)
    : { capped: false, uids: [] }
  const candidateUids = boundedThreadDetailUids([...discovered.uids, token.seedUid], token.seedUid)
  const headers = await fetchThreadHeaders(session, candidateUids)
  const validatedMembers = validateMailboxThreadMembers(token, headers, options.threadTokenSecret ?? '')
  if (!validatedMembers) return null
  const messages: MailboxMailConversation['messages'] = []
  let remainingBody = MAX_CONVERSATION_BODY_CHARS
  let remainingResponse = MAX_CONVERSATION_RESPONSE_BYTES
  let responseBounded = false
  for (const member of validatedMembers.sort((left, right) => right.uid - left.uid)
    .slice(0, MAX_CONVERSATION_MESSAGES)) {
    const bodyStructure = member.bodyStructure?.length
      ? member.bodyStructure
      : (await session.fetchBodyStructures([member.uid]))[0]?.bodyStructure ?? []
    const textPart = preferredTextPart(bodyStructure)
    if (!textPart) continue
    const requestedBytes = Math.min(MAX_TEXT_SECTION_BYTES, Math.max(1, remainingResponse))
    const payload = await session.fetchBodySection(member.uid, textPart.section, requestedBytes)
    if (!payload) continue
    const decoded = decodedPart(payload, textPart.encoding)
    if (decoded.byteLength > remainingResponse) {
      responseBounded = true
      break
    }
    remainingResponse -= decoded.byteLength
    if (payload.byteLength === requestedBytes) responseBounded = true
    const decodedText = textFromPart(decoded, textPart.charset)
    const sanitized = textPart.textKind === 'html' ? sanitizeEmailHtml(decodedText) : null
    const body = sanitized?.html ?? decodedText
    const boundedBody = body.slice(0, Math.min(MAX_BODY_CHARS, remainingBody))
    remainingBody -= boundedBody.length
    messages.push({
      attachments: messageAttachments(bodyStructure),
      blockedRemoteContent: sanitized?.blockedRemoteContent ?? false,
      body: boundedBody,
      bodyFormat: textPart.textKind === 'html' ? 'html' : 'text',
      cc: member.cc,
      from: member.from,
      id: String(member.uid),
      inReplyTo: member.inReplyTo,
      messageId: member.messageId,
      receivedAt: member.date,
      subject: member.subject,
      threadId: input.threadId,
      to: member.to,
    })
  }
  return {
    earlierMessagesMayExist: discovered.capped || validatedMembers.length > messages.length
      || remainingBody === 0 || responseBounded,
    id: input.threadId,
    messages: messages.sort((left, right) => (left.receivedAt ?? '').localeCompare(right.receivedAt ?? '')),
  }
})
