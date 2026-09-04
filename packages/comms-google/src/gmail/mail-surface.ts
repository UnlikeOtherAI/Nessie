import { sanitizeEmailHtml, htmlToText, buildSnippet } from '@nessie/agent-mail'

import { GMAIL_API_BASE, encodeForm, requestJson, type FetchLike } from '../http.js'

const MAX_BODY_CHARS = 100_000

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

const recipients = (value: string): string[] =>
  value.split(',').map((entry) => entry.trim()).filter(Boolean)

const date = (value: unknown): string | null => {
  const milliseconds = typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null
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
  if (filename && typeof part.body?.attachmentId === 'string') {
    into.attachments.push({
      contentType: typeof part.mimeType === 'string' ? part.mimeType : 'application/octet-stream',
      filename,
      sizeBytes: typeof part.body.size === 'number' ? part.body.size : 0,
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
    from: header(message.payload?.headers, 'From') || null,
    id: message.id,
    inReplyTo: header(message.payload?.headers, 'In-Reply-To') || null,
    receivedAt: date(message.internalDate),
    subject: header(message.payload?.headers, 'Subject') || '(no subject)',
    threadId: typeof message.threadId === 'string' ? message.threadId : fallbackThreadId,
    to: recipients(header(message.payload?.headers, 'To')),
    unread: Array.isArray(message.labelIds) && message.labelIds.includes('UNREAD'),
  }
}

const queryFor = (query: string | undefined, unreadOnly: boolean | undefined): string | undefined => {
  const terms = [query?.trim(), unreadOnly ? 'is:unread' : undefined].filter(Boolean)
  return terms.length > 0 ? terms.join(' ') : undefined
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
    threads?: Array<{ id?: unknown }>
    nextPageToken?: unknown
    resultSizeEstimate?: unknown
  }
  const items: GmailMailThreadPage['items'] = []
  for (const ref of listed.threads ?? []) {
    if (typeof ref?.id !== 'string') continue
    const conversation = await readGmailMailThread(fetchImpl, accessToken, ref.id)
    const newest = conversation.messages.at(-1)
    if (!newest) continue
    const rawMessages = conversation.messages
    items.push({
      from: newest.from,
      hasAttachments: rawMessages.some((message) => message.attachments.length > 0),
      id: ref.id,
      messageCount: rawMessages.length,
      receivedAt: newest.receivedAt,
      snippet: buildSnippet(newest.bodyFormat === 'html' ? htmlToText(newest.body) : newest.body),
      subject: newest.subject,
      unread: newest.unread,
    })
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
  const messages = ((body as { messages?: unknown[] }).messages ?? [])
    .flatMap((message) => {
      const normalized = toMessage(message, threadId)
      return normalized ? [normalized] : []
    })
    .sort((left, right) => (left.receivedAt ?? '').localeCompare(right.receivedAt ?? ''))
  return { id: threadId, messages }
}
