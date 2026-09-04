import { createHash } from 'node:crypto'

import { ImapError, type ImapSession } from './imap.js'
import { imapAttachmentParts, imapTextParts, type ImapBodyPart } from './imap-bodystructure.js'
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

const stableFallbackSeed = async (
  session: ImapSession,
  group: { members: MailboxThreadHeader[]; root: string | null },
): Promise<MailboxThreadHeader | null> => {
  const presentRoot = group.members.find((member) => member.messageId === group.root)
  if (presentRoot) return presentRoot
  if (!group.root) return [...group.members].sort((left, right) => left.uid - right.uid)[0] ?? null
  // A root can sit outside the list's newest-header allocation. Locate it by
  // its structural Message-ID, not a subject convention, and verify the live
  // header before using its immutable UID as a public token seed.
  const candidates = await session.searchMessageIdUids(group.root)
  const headers = await fetchThreadHeaders(session, candidates.slice(-1))
  return headers.find((header) => header.messageId === group.root) ?? null
}

export const validateMailboxThreadMembers = (
  token: ParsedMailboxThreadToken,
  headers: MailboxThreadHeader[],
  tokenSecret: string,
): MailboxThreadHeader[] | null => {
  const seededGroup = threadHeaders(headers, token.accountId, token.folder, token.uidValidity, tokenSecret)
    .find((group) => group.members.some((member) => member.uid === token.seedUid))
  if (!seededGroup) return null
  const canonical = parseMailboxThreadToken(seededGroup.id, {
    accountId: token.accountId,
    folder: token.folder,
    secret: tokenSecret,
  })
  return canonical?.rootDigest === token.rootDigest && canonical.seedUid === token.seedUid
    ? seededGroup.members
    : null
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
  const tokenSecret = options.threadTokenSecret
  if (!tokenSecret) throw new ImapError('Mailbox thread tokens are not configured.', 'protocol')
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
  const threadNeedsUtf8 = criteria.some(
    (part) => typeof part !== 'string' && /[^\x00-\x7F]/.test(part.literal),
  )
  // A server advertises its UTF-8 threading support explicitly. ASCII criteria
  // use the baseline charset and remain available on older RFC 5256 servers.
  const nativeGroups = capabilities.has('THREAD=REFERENCES')
    && (!threadNeedsUtf8 || capabilities.has('UTF8=ACCEPT') || capabilities.has('UTF8=ONLY'))
    ? await session.threadReferencesUids(criteria, threadNeedsUtf8 ? 'UTF-8' : 'US-ASCII')
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
  const unseededFallbackGroups = orderedNativeGroups
    ? []
    : threadHeaders(initialHeaders, input.accountId, folder, selected.uidValidity, tokenSecret)
      .sort((left, right) => Math.max(...right.members.map((member) => member.uid))
        - Math.max(...left.members.map((member) => member.uid)))
  const fallbackGroups = orderedNativeGroups ? [] : unseededFallbackGroups
  const pageUnits = orderedNativeGroups
    ? orderedNativeGroups.slice(cursor.offset, cursor.offset + input.pageSize)
    : fallbackGroups.slice(cursor.offset, cursor.offset + input.pageSize)
      .map((group) => group.members.map((member) => member.uid))
  const resolvedFallbackPageGroups = orderedNativeGroups
    ? []
    : await Promise.all(fallbackGroups.slice(cursor.offset, cursor.offset + input.pageSize).map(async (group) => {
      const seed = await stableFallbackSeed(session, group)
      if (!seed) return group
      return {
        ...group,
        id: mailboxThreadToken({
          accountId: input.accountId,
          folder,
          rootMessageId: group.root,
          uid: seed.uid,
          uidValidity: selected.uidValidity,
        }, tokenSecret),
      }
    }))
  const pageUids = orderedNativeGroups
    ? nativeThreadHeaderUids(pageUnits)
    : [...new Set(pageUnits.flat())]
      .sort((left, right) => right - left)
      .slice(0, HEADER_WINDOW_LIMIT)
  const headers = orderedNativeGroups
    ? await fetchThreadHeaders(session, pageUids)
    : initialHeaders.filter((header) => pageUids.includes(header.uid))
  // Summary allocation deliberately reserves one newest header per visible
  // group.  Roots are fetched separately solely to mint a stable token; they
  // never decide which members an open reader is allowed to recover.
  const seedHeaders = orderedNativeGroups
    ? await fetchThreadHeaders(session, nativeThreadSeedUids(pageUnits))
    : []
  const seedHeaderByUid = new Map(seedHeaders.map((header) => [header.uid, header]))
  const groups: Array<{ id?: string; members: MailboxThreadHeader[]; messageCount: number }> = orderedNativeGroups
    ? pageUnits.map((memberUids) => ({
        members: headers.filter((header) => memberUids.includes(header.uid)),
        messageCount: memberUids.length,
      }))
    : resolvedFallbackPageGroups.map((group) => ({
        ...group,
        members: group.members.filter((member) => pageUids.includes(member.uid)),
        messageCount: group.members.length,
      }))
  const rows = groups.map(({ id, members, messageCount }, index) => {
    const fallback = members[0]
    const seedUid = orderedNativeGroups ? pageUnits[index]?.[0] : undefined
    const seed = seedUid ? seedHeaderByUid.get(seedUid) : undefined
    const threadId = id ?? (fallback && seed
      ? mailboxThreadToken({
          accountId: input.accountId,
          folder,
          rootMessageId: seed.messageId ?? seed.references[0] ?? seed.inReplyTo,
          uid: seed.uid,
          uidValidity: selected.uidValidity,
        }, tokenSecret)
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
    ? encodeCursor({ ...cursor, offset: nextOffset, uidValidity: selected.uidValidity })
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
  const capabilities = await session.capabilities()
  let validatedMembers: MailboxThreadHeader[] | null = null
  let currentGroupMessageCount = 0
  if (capabilities.has('THREAD=REFERENCES')) {
    const group = (await session.threadReferencesUids(['ALL']))
      .find((candidate) => candidate.includes(token.seedUid))
    if (!group) return null
    const headers = await fetchThreadHeaders(session, boundedThreadDetailUids(group, token.seedUid))
    const seed = headers.find((header) => header.uid === token.seedUid)
    const digest = seed && mailboxThreadRootDigest({
      rootMessageId: seed.messageId ?? seed.references[0] ?? seed.inReplyTo,
      uid: token.seedUid,
      uidValidity: selected.uidValidity,
    })
    if (digest !== token.rootDigest) return null
    validatedMembers = headers.filter((header) => group.includes(header.uid))
    currentGroupMessageCount = group.length
  } else {
    // Without RFC 5256 support, derive only a bounded structural window.  The
    // stable seed is kept even after newer mail pushes it out of that window.
    const candidateUids = boundedThreadDetailUids(await session.searchUids(['ALL']), token.seedUid)
    const headers = await fetchThreadHeaders(session, candidateUids)
    validatedMembers = validateMailboxThreadMembers(token, headers, options.threadTokenSecret ?? '')
    currentGroupMessageCount = validatedMembers?.length ?? 0
  }
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
    earlierMessagesMayExist: currentGroupMessageCount > messages.length || remainingBody === 0 || responseBounded,
    id: input.threadId,
    messages: messages.sort((left, right) => (left.receivedAt ?? '').localeCompare(right.receivedAt ?? '')),
  }
})
