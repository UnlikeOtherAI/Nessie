import { sanitizeEmailHtml, buildSnippet, normalizeMessageId } from '@nessie/agent-mail'

import { GMAIL_API_BASE, encodeForm, requestJson, type FetchLike } from '../http.js'

const MAX_BODY_CHARS = 100_000
const MAX_ATTACHMENTS = 100
const MAX_ADDRESS_CHARS = 1_000
const MAX_ATTACH_NAME_CHARS = 500
const MAX_CONTENT_TYPE_CHARS = 200
const MAX_HEADER_CHARS = 1_000
const MAX_MESSAGES = 200

const bounded = (value: string, max: number): string => value.slice(0, max)
const optionalHeader = (value: string, max = MAX_HEADER_CHARS): string | null =>
  value ? bounded(value, max) : null
const attachmentSize = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0

export type GmailMailThreadPage = {
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
  estimate?: number
}

export type GmailMailConversation = {
  id: string
  earlierMessagesMayExist: boolean
  messageCount: number
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
    unread: boolean
    attachments: { filename: string; contentType: string; sizeBytes: number }[]
    messageId: string | null
    inReplyTo: string | null
  }>
}

type Header = { name?: unknown; value?: unknown }
type Part = {
  mimeType?: unknown
  filename?: unknown
  body?: { data?: unknown; size?: unknown; attachmentId?: unknown }
  headers?: Header[]
  parts?: Part[]
}
type Message = {
  id?: unknown
  threadId?: unknown
  internalDate?: unknown
  labelIds?: unknown
  snippet?: unknown
  payload?: Part & { headers?: Header[] }
}

const header = (headers: Header[] | undefined, name: string): string => {
  const match = headers?.find((entry) =>
    typeof entry.name === 'string' && entry.name.toLowerCase() === name.toLowerCase())
  return typeof match?.value === 'string' ? match.value : ''
}

/** Commas in an RFC quoted display name are not recipient delimiters. */
const recipients = (value: string): string[] => {
  const entries: string[] = []
  let current = ''
  let escaped = false
  let quoted = false
  for (const character of value) {
    if (character === '"' && !escaped) quoted = !quoted
    if (character === ',' && !quoted) {
      entries.push(current)
      current = ''
    } else current += character
    escaped = character === '\\' && !escaped
    if (character !== '\\') escaped = false
  }
  entries.push(current)
  return entries.map((entry) => bounded(entry.trim(), MAX_ADDRESS_CHARS)).filter(Boolean).slice(0, 100)
}

const date = (value: unknown): string | null => {
  const milliseconds = typeof value === 'string' ? Number(value) : NaN
  const parsed = Number.isFinite(milliseconds) ? new Date(milliseconds) : null
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null
}

const decode = (value: unknown): string =>
  typeof value === 'string' ? Buffer.from(value, 'base64url').toString('utf8') : ''

const collect = (part: Part | undefined, into: {
  text: string
  html: string
  attachments: GmailMailConversation['messages'][number]['attachments']
}): void => {
  if (!part) return
  const filename = typeof part.filename === 'string' ? part.filename : ''
  if (filename && (typeof part.body?.attachmentId === 'string' || typeof part.body?.data === 'string')
    && into.attachments.length < MAX_ATTACHMENTS) {
    into.attachments.push({
      contentType: bounded(
        typeof part.mimeType === 'string' && part.mimeType ? part.mimeType : 'application/octet-stream',
        MAX_CONTENT_TYPE_CHARS,
      ),
      filename: bounded(filename, MAX_ATTACH_NAME_CHARS),
      sizeBytes: attachmentSize(part.body.size),
    })
    return
  }
  if (part.mimeType === 'text/plain' && !into.text) into.text = decode(part.body?.data)
  if (part.mimeType === 'text/html' && !into.html) into.html = decode(part.body?.data)
  for (const child of part.parts ?? []) collect(child, into)
}

const toMessage = (
  raw: unknown,
  fallbackThreadId: string,
): GmailMailConversation['messages'][number] | null => {
  const message = raw as Message
  if (typeof message.id !== 'string') return null
  const collected = { attachments: [], html: '', text: '' } as {
    text: string
    html: string
    attachments: GmailMailConversation['messages'][number]['attachments']
  }
  collect(message.payload, collected)
  const safeHtml = sanitizeEmailHtml(collected.html)
  const bodyFormat = safeHtml.html ? 'html' : 'text'
  const body = (bodyFormat === 'html' ? safeHtml.html : collected.text).slice(0, MAX_BODY_CHARS)
  return {
    attachments: collected.attachments,
    blockedRemoteContent: safeHtml.blockedRemoteContent,
    body,
    bodyFormat,
    cc: recipients(header(message.payload?.headers, 'Cc')),
    from: optionalHeader(header(message.payload?.headers, 'From')),
    id: message.id,
    inReplyTo: optionalHeader(normalizeMessageId(header(message.payload?.headers, 'In-Reply-To')) ?? ''),
    messageId: optionalHeader(normalizeMessageId(header(message.payload?.headers, 'Message-ID')) ?? ''),
    receivedAt: date(message.internalDate),
    subject: bounded(header(message.payload?.headers, 'Subject') || '(no subject)', MAX_HEADER_CHARS),
    threadId: typeof message.threadId === 'string' ? message.threadId : fallbackThreadId,
    to: recipients(header(message.payload?.headers, 'To')),
    unread: Array.isArray(message.labelIds) && message.labelIds.includes('UNREAD'),
  }
}

const queryFor = (query: string | undefined, unreadOnly: boolean | undefined): string | undefined => {
  const terms = [query?.trim(), unreadOnly ? 'is:unread' : undefined].filter(Boolean)
  return terms.length > 0 ? terms.join(' ') : undefined
}

const metadataThreadUrl = (threadId: string): string => {
  const headers = ['From', 'Subject'].map((name) => `metadataHeaders=${name}`).join('&')
  return `${GMAIL_API_BASE}/threads/${encodeURIComponent(threadId)}?format=metadata&${headers}`
}

const hasAttachmentMetadata = (part: Part | undefined): boolean => Boolean(
  part && (typeof part.filename === 'string' && part.filename.length > 0
    || (part.parts ?? []).some((child) => hasAttachmentMetadata(child))),
)

const metadataSummary = (
  threadId: string,
  listedSnippet: unknown,
  rawMessages: unknown[],
): GmailMailThreadPage['items'][number] | null => {
  const messages = rawMessages.map((raw) => raw as Message)
  const newest = [...messages].sort((left, right) =>
    (date(left.internalDate) ?? '').localeCompare(date(right.internalDate) ?? '')).at(-1)
  if (!newest) return null
  return {
    from: optionalHeader(header(newest.payload?.headers, 'From')),
    hasAttachments: messages.some((message) => hasAttachmentMetadata(message.payload)),
    id: threadId,
    messageCount: messages.length,
    receivedAt: date(newest.internalDate),
    snippet: buildSnippet(typeof newest.snippet === 'string'
      ? newest.snippet
      : typeof listedSnippet === 'string' ? listedSnippet : ''),
    subject: bounded(header(newest.payload?.headers, 'Subject') || '(no subject)', MAX_HEADER_CHARS),
    unread: messages.some((message) => Array.isArray(message.labelIds) && message.labelIds.includes('UNREAD')),
  }
}

/** Gmail-native thread paging. Cursors and estimates remain provider semantics. */
export const listGmailMailThreads = async (
  fetchImpl: FetchLike,
  accessToken: string,
  input: { cursor?: string; pageSize: number; query?: string; unreadOnly?: boolean },
): Promise<GmailMailThreadPage> => {
  const params: Record<string, string> = { maxResults: String(input.pageSize) }
  const query = queryFor(input.query, input.unreadOnly)
  if (query) params.q = query
  if (input.cursor) params.pageToken = input.cursor
  const { body } = await requestJson(
    fetchImpl,
    'threads.list',
    `${GMAIL_API_BASE}/threads?${encodeForm(params)}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  )
  const listed = body as {
    threads?: Array<{ id?: unknown; snippet?: unknown }>
    nextPageToken?: unknown
    resultSizeEstimate?: unknown
  }
  const items: GmailMailThreadPage['items'] = []
  for (const ref of listed.threads ?? []) {
    if (typeof ref?.id !== 'string') continue
    const { body: metadata } = await requestJson(
      fetchImpl,
      'threads.get.metadata',
      metadataThreadUrl(ref.id),
      { headers: { authorization: `Bearer ${accessToken}` } },
    )
    const summary = metadataSummary(
      ref.id,
      ref.snippet,
      (metadata as { messages?: unknown[] }).messages ?? [],
    )
    if (summary) items.push(summary)
  }
  return {
    ...(typeof listed.nextPageToken === 'string' ? { nextCursor: listed.nextPageToken } : {}),
    ...(typeof listed.resultSizeEstimate === 'number' ? { estimate: listed.resultSizeEstimate } : {}),
    items,
  }
}

/** Full, sanitized messages for a single native Gmail thread. */
export const readGmailMailThread = async (
  fetchImpl: FetchLike,
  accessToken: string,
  threadId: string,
): Promise<GmailMailConversation> => {
  const { body } = await requestJson(
    fetchImpl,
    'threads.get',
    `${GMAIL_API_BASE}/threads/${encodeURIComponent(threadId)}?format=full`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  )
  const normalized = ((body as { messages?: unknown[] }).messages ?? [])
    .flatMap((message) => {
      const normalized = toMessage(message, threadId)
      return normalized ? [normalized] : []
    })
    .sort((left, right) => (left.receivedAt ?? '').localeCompare(right.receivedAt ?? ''))
  const earlierMessagesMayExist = normalized.length > MAX_MESSAGES
  const messages = normalized.slice(-MAX_MESSAGES)
  return { earlierMessagesMayExist, id: threadId, messageCount: normalized.length, messages }
}
