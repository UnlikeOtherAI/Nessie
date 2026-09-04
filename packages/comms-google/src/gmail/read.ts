import { requestJson, GMAIL_API_BASE, encodeForm, type FetchLike } from '../http.js'
import {
  GMAIL_MAX_METADATA_RESPONSE_BYTES,
  GMAIL_MAX_READ_RESPONSE_BYTES,
  GmailReadBudget,
  GmailReadLimitError,
} from './read-budget.js'
import { GMAIL_MAX_ATTACHMENTS, GMAIL_MAX_PART_DEPTH, GMAIL_MAX_PARTS } from './part-limits.js'

/**
 * Gmail read operations for the agent tools.
 *
 * These read LIVE from Gmail rather than the `CommsEvent` store. The store is
 * the async index for retrieval; a person asking "what did Jana say this
 * morning" must not depend on whether a Pub/Sub push has landed yet. Keeping
 * both paths is deliberate — do not route tools through the store.
 */

export type GmailThreadSummary = {
  threadId: string
  messageId: string
  rfcMessageId?: string
  from: string
  to: string[]
  subject: string
  snippet: string
  receivedAt: string
  unread: boolean
  hasAttachments: boolean
}

export type GmailMessageDetail = {
  messageId: string
  rfcMessageId?: string
  threadId: string
  from: string
  to: string[]
  cc: string[]
  subject: string
  receivedAt: string
  body: string
  attachments: { attachmentId: string; filename: string; mimeType: string; sizeBytes: number }[]
}

type RawHeader = { name?: unknown; value?: unknown }

export const GMAIL_MAX_READ_HEADERS = 100
export const GMAIL_MAX_READ_HEADER_BYTES = 1_000
export const GMAIL_MAX_READ_ADDRESSES = 50
export const GMAIL_MAX_READ_FILENAME_BYTES = 500
export const GMAIL_MAX_READ_MIME_TYPE_BYTES = 200
export const GMAIL_MAX_READ_THREAD_MESSAGES = 100
export const GMAIL_MAX_READ_SNIPPET_CHARS = 4_000

const assertHeaders = (headers: RawHeader[]): void => {
  if (headers.length > GMAIL_MAX_READ_HEADERS || headers.some((header) => {
    const name = typeof header?.name === 'string' ? header.name : ''
    const value = typeof header?.value === 'string' ? header.value : ''
    return Buffer.byteLength(name) > GMAIL_MAX_READ_HEADER_BYTES
      || Buffer.byteLength(value) > GMAIL_MAX_READ_HEADER_BYTES
  })) throw new GmailReadLimitError('structure')
}

const headerValue = (headers: RawHeader[], name: string): string => {
  assertHeaders(headers)
  const match = headers.find(
    (header) =>
      typeof header?.name === 'string'
      && header.name.toLowerCase() === name.toLowerCase(),
  )
  return typeof match?.value === 'string' ? match.value : ''
}

const splitAddressList = (value: string): string[] => {
  const entries = value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
  if (entries.length > GMAIL_MAX_READ_ADDRESSES || entries.some((entry) =>
    Buffer.byteLength(entry) > GMAIL_MAX_READ_HEADER_BYTES)) throw new GmailReadLimitError('structure')
  return entries
}

type RawPart = {
  mimeType?: unknown
  filename?: unknown
  body?: { data?: unknown; size?: unknown; attachmentId?: unknown }
  parts?: RawPart[]
  headers?: RawHeader[]
}

const walk = (
  part: RawPart | undefined,
  into: { body: string; attachments: GmailMessageDetail['attachments'] },
  budget: GmailReadBudget,
  depth = 0,
  seen = { parts: 0 },
): void => {
  if (!part) return
  if (depth > GMAIL_MAX_PART_DEPTH || ++seen.parts > GMAIL_MAX_PARTS) {
    throw new GmailReadLimitError('structure')
  }
  const filename = typeof part.filename === 'string' ? part.filename : ''
  const attachmentId =
    typeof part.body?.attachmentId === 'string' ? part.body.attachmentId : ''
  if (filename.length > 0 && attachmentId.length > 0) {
    if (into.attachments.length >= GMAIL_MAX_ATTACHMENTS
      || Buffer.byteLength(filename) > GMAIL_MAX_READ_FILENAME_BYTES
      || (typeof part.mimeType === 'string' && Buffer.byteLength(part.mimeType) > GMAIL_MAX_READ_MIME_TYPE_BYTES)) {
      throw new GmailReadLimitError('structure')
    }
    into.attachments.push({
      attachmentId,
      filename,
      mimeType: typeof part.mimeType === 'string' ? part.mimeType : '',
      sizeBytes: typeof part.body?.size === 'number' ? part.body.size : 0,
    })
    return
  }
  if (
    part.mimeType === 'text/plain'
    && typeof part.body?.data === 'string'
    && into.body.length === 0
  ) {
    into.body = budget.decode(part.body.data)
    return
  }
  for (const child of part.parts ?? []) walk(child, into, budget, depth + 1, seen)
}

const hasAttachment = (
  part: RawPart | undefined,
  depth = 0,
  seen = { parts: 0 },
): boolean => {
  if (!part) return false
  if (depth > GMAIL_MAX_PART_DEPTH || ++seen.parts > GMAIL_MAX_PARTS) {
    throw new GmailReadLimitError('structure')
  }
  if (typeof part.filename === 'string' && part.filename.length > 0) {
    if (Buffer.byteLength(part.filename) > GMAIL_MAX_READ_FILENAME_BYTES) {
      throw new GmailReadLimitError('structure')
    }
    return true
  }
  return (part.parts ?? []).some((child) => hasAttachment(child, depth + 1, seen))
}

const parseInternalDate = (value: unknown): string => {
  const millis = typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(millis)
    ? new Date(millis).toISOString()
    : new Date(0).toISOString()
}

const mapBounded = async <T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = []
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++
      results[index] = await map(values[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker))
  return results
}

/**
 * Search threads. `query` is passed to Gmail verbatim, so the model can use
 * Gmail's own operators (`from:`, `has:attachment`, `newer_than:7d`) — that is
 * a capability of the provider, not intent detection on our side.
 */
export const searchGmailThreads = async (
  fetchImpl: FetchLike,
  accessToken: string,
  input: { query?: string; maxResults?: number; labelIds?: string[] },
): Promise<GmailThreadSummary[]> => {
  const budget = new GmailReadBudget()
  const params: Record<string, string> = {
    maxResults: String(Math.min(Math.max(input.maxResults ?? 15, 1), 50)),
  }
  if (input.query) params.q = input.query
  const listedResponse = await requestJson(
    fetchImpl,
    'messages.list',
    `${GMAIL_API_BASE}/messages?${encodeForm(params)}${
      (input.labelIds ?? [])
        .map((id) => `&labelIds=${encodeURIComponent(id)}`)
        .join('')
    }`,
    { headers: { authorization: `Bearer ${accessToken}` }, maxResponseBytes: GMAIL_MAX_READ_RESPONSE_BYTES },
  )
  budget.addHttp(listedResponse.responseBytes ?? 0)
  const { body } = listedResponse
  const refs = (body as { messages?: { id?: unknown }[] }).messages ?? []

  const messageIds = refs.flatMap((ref) => typeof ref?.id === 'string' ? [ref.id] : [])
  const summaries = await mapBounded(messageIds, 8, async (messageId) => {
    // `metadata` format returns headers without bodies — enough for a list and
    // far smaller than pulling every full message into the context window.
    const response = await requestJson(
      fetchImpl,
      'messages.get',
      `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}`
        + '?format=metadata&metadataHeaders=From&metadataHeaders=To'
        + '&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID',
      { headers: { authorization: `Bearer ${accessToken}` }, maxResponseBytes: GMAIL_MAX_METADATA_RESPONSE_BYTES },
    )
    budget.addHttp(response.responseBytes ?? 0)
    const raw = response.body
    const message = raw as {
      id?: unknown
      threadId?: unknown
      snippet?: unknown
      internalDate?: unknown
      labelIds?: unknown
      payload?: { headers?: RawHeader[]; parts?: RawPart[] }
    }
    if (typeof message?.id !== 'string') return null
    const headers = message.payload?.headers ?? []
    const labelIds = Array.isArray(message.labelIds) ? message.labelIds : []
    return {
      threadId: typeof message.threadId === 'string' ? message.threadId : message.id,
      messageId: message.id,
      ...(headerValue(headers, 'Message-ID') ? { rfcMessageId: headerValue(headers, 'Message-ID') } : {}),
      from: headerValue(headers, 'From'),
      to: splitAddressList(headerValue(headers, 'To')),
      subject: headerValue(headers, 'Subject'),
      snippet: typeof message.snippet === 'string'
        ? message.snippet.slice(0, GMAIL_MAX_READ_SNIPPET_CHARS)
        : '',
      receivedAt: parseInternalDate(message.internalDate),
      unread: labelIds.includes('UNREAD'),
      hasAttachments: hasAttachment(message.payload),
    }
  })
  return summaries.filter((summary): summary is GmailThreadSummary => summary !== null)
}

export const getGmailMessage = async (
  fetchImpl: FetchLike,
  accessToken: string,
  messageId: string,
): Promise<GmailMessageDetail> => {
  const budget = new GmailReadBudget()
  const response = await requestJson(
    fetchImpl,
    'messages.get',
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}?format=full`,
    { headers: { authorization: `Bearer ${accessToken}` }, maxResponseBytes: GMAIL_MAX_READ_RESPONSE_BYTES },
  )
  budget.addHttp(response.responseBytes ?? 0)
  const { body } = response
  const message = body as {
    id?: unknown
    threadId?: unknown
    internalDate?: unknown
    payload?: RawPart & { headers?: RawHeader[] }
  }
  if (typeof message?.id !== 'string') {
    throw new Error('[comms-google] Gmail returned a message with no id')
  }
  const headers = message.payload?.headers ?? []
  const collected = { body: '', attachments: [] as GmailMessageDetail['attachments'] }
  walk(message.payload, collected, budget)
  return {
    messageId: message.id,
    ...(headerValue(headers, 'Message-ID') ? { rfcMessageId: headerValue(headers, 'Message-ID') } : {}),
    threadId: typeof message.threadId === 'string' ? message.threadId : message.id,
    from: headerValue(headers, 'From'),
    to: splitAddressList(headerValue(headers, 'To')),
    cc: splitAddressList(headerValue(headers, 'Cc')),
    subject: headerValue(headers, 'Subject'),
    receivedAt: parseInternalDate(message.internalDate),
    body: collected.body,
    attachments: collected.attachments,
  }
}

/** Every message in one thread, oldest first. */
export const getGmailThread = async (
  fetchImpl: FetchLike,
  accessToken: string,
  threadId: string,
): Promise<GmailMessageDetail[]> => {
  const budget = new GmailReadBudget()
  const response = await requestJson(
    fetchImpl,
    'threads.get',
    `${GMAIL_API_BASE}/threads/${encodeURIComponent(threadId)}?format=full`,
    { headers: { authorization: `Bearer ${accessToken}` }, maxResponseBytes: GMAIL_MAX_READ_RESPONSE_BYTES },
  )
  budget.addHttp(response.responseBytes ?? 0)
  const { body } = response
  const messages = (body as { messages?: unknown[] }).messages ?? []
  if (messages.length > GMAIL_MAX_READ_THREAD_MESSAGES) throw new GmailReadLimitError('structure')
  return messages.flatMap((raw) => {
    const message = raw as {
      id?: unknown
      threadId?: unknown
      internalDate?: unknown
      payload?: RawPart & { headers?: RawHeader[] }
    }
    if (typeof message?.id !== 'string') return []
    const headers = message.payload?.headers ?? []
    const collected = { body: '', attachments: [] as GmailMessageDetail['attachments'] }
    walk(message.payload, collected, budget)
    return [{
      messageId: message.id,
      ...(headerValue(headers, 'Message-ID') ? { rfcMessageId: headerValue(headers, 'Message-ID') } : {}),
      threadId: typeof message.threadId === 'string' ? message.threadId : threadId,
      from: headerValue(headers, 'From'),
      to: splitAddressList(headerValue(headers, 'To')),
      cc: splitAddressList(headerValue(headers, 'Cc')),
      subject: headerValue(headers, 'Subject'),
      receivedAt: parseInternalDate(message.internalDate),
      body: collected.body,
      attachments: collected.attachments,
    }]
  })
}

export type GmailLabelRef = { id: string; name: string; type: string }

export const listGmailLabels = async (
  fetchImpl: FetchLike,
  accessToken: string,
): Promise<GmailLabelRef[]> => {
  const { body } = await requestJson(
    fetchImpl,
    'labels.list',
    `${GMAIL_API_BASE}/labels`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  )
  const labels = (body as { labels?: unknown[] }).labels ?? []
  return labels.flatMap((raw) => {
    const label = raw as { id?: unknown; name?: unknown; type?: unknown }
    return typeof label?.id === 'string'
      ? [{
          id: label.id,
          name: typeof label.name === 'string' ? label.name : label.id,
          type: typeof label.type === 'string' ? label.type : 'user',
        }]
      : []
  })
}

/**
 * Add and remove labels on a thread.
 *
 * Archive and mark-read are the same operation to Gmail — removing the `INBOX`
 * or `UNREAD` label — so there is one function rather than three that would
 * drift apart.
 */
export const modifyGmailThread = async (
  fetchImpl: FetchLike,
  accessToken: string,
  input: { threadId: string; addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<void> => {
  await requestJson(
    fetchImpl,
    'threads.modify',
    `${GMAIL_API_BASE}/threads/${encodeURIComponent(input.threadId)}/modify`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        addLabelIds: input.addLabelIds ?? [],
        removeLabelIds: input.removeLabelIds ?? [],
      }),
    },
  )
}

/** Move a thread to trash. Recoverable in Gmail for 30 days. */
export const trashGmailThread = async (
  fetchImpl: FetchLike,
  accessToken: string,
  threadId: string,
): Promise<void> => {
  await requestJson(
    fetchImpl,
    'threads.trash',
    `${GMAIL_API_BASE}/threads/${encodeURIComponent(threadId)}/trash`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    },
  )
}

/** One attachment's bytes, for handing to the FileService. */
export const getGmailAttachment = async (
  fetchImpl: FetchLike,
  accessToken: string,
  input: { messageId: string; attachmentId: string },
): Promise<Buffer> => {
  const { body } = await requestJson(
    fetchImpl,
    'attachments.get',
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(input.messageId)}`
      + `/attachments/${encodeURIComponent(input.attachmentId)}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  )
  const data = (body as { data?: unknown }).data
  if (typeof data !== 'string') {
    throw new Error('[comms-google] attachment carried no data')
  }
  return Buffer.from(data, 'base64url')
}
