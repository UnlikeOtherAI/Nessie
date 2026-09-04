import { createHash } from 'node:crypto'

import { requestJson, GMAIL_API_BASE, type FetchLike } from '../http.js'
import {
  buildRawMessage,
  type GmailDraftAttachmentIdentity,
  type OutboundMessage,
} from './mime-build.js'

/**
 * Gmail draft operations.
 *
 * Scope note that decides the whole tool surface: `users.drafts.create` and
 * `users.drafts.send` accept `gmail.compose` or `gmail.modify` — NOT
 * `gmail.send`. A send-only grant can call `users.messages.send` and nothing
 * here. The capability catalog encodes that; these functions assume the caller
 * already proved the right scope at the credential chokepoint.
 */

export type GmailDraftRef = {
  id: string
  messageId: string
  threadId?: string
}

const bearer = (accessToken: string): Record<string, string> => ({
  authorization: `Bearer ${accessToken}`,
  'content-type': 'application/json',
})

const readDraftRef = (body: unknown): GmailDraftRef => {
  const draft = body as {
    id?: unknown
    message?: { id?: unknown; threadId?: unknown }
  }
  if (typeof draft?.id !== 'string' || typeof draft.message?.id !== 'string') {
    throw new Error('[comms-google] Gmail returned a draft with no id')
  }
  return {
    id: draft.id,
    // Gmail issues a NEW message id on every draft update. It is a useful
    // corroborating signal that a draft changed, but never the authority —
    // the content fingerprint is.
    messageId: draft.message.id,
    ...(typeof draft.message.threadId === 'string'
      ? { threadId: draft.message.threadId }
      : {}),
  }
}

export const createGmailDraft = async (
  fetchImpl: FetchLike,
  accessToken: string,
  message: OutboundMessage,
  threadId?: string,
): Promise<GmailDraftRef> => {
  const { body } = await requestJson(
    fetchImpl,
    'drafts.create',
    `${GMAIL_API_BASE}/drafts`,
    {
      method: 'POST',
      headers: bearer(accessToken),
      body: JSON.stringify({
        message: {
          raw: buildRawMessage(message),
          ...(threadId ? { threadId } : {}),
        },
      }),
    },
  )
  return readDraftRef(body)
}

export const updateGmailDraft = async (
  fetchImpl: FetchLike,
  accessToken: string,
  draftId: string,
  message: OutboundMessage,
  threadId?: string,
): Promise<GmailDraftRef> => {
  const { body } = await requestJson(
    fetchImpl,
    'drafts.update',
    `${GMAIL_API_BASE}/drafts/${encodeURIComponent(draftId)}`,
    {
      method: 'PUT',
      headers: bearer(accessToken),
      body: JSON.stringify({
        message: {
          raw: buildRawMessage(message),
          ...(threadId ? { threadId } : {}),
        },
      }),
    },
  )
  return readDraftRef(body)
}

/** The stored draft, parsed back into the shape the card renders. */
export type GmailDraftContent = {
  id: string
  messageId: string
  threadId?: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  /** Provider identity stays server-side; callers must project it before UI. */
  attachments: GmailDraftAttachmentIdentity[]
}

const headerValue = (
  headers: { name?: unknown; value?: unknown }[],
  name: string,
): string => {
  const match = headers.find(
    (header) =>
      typeof header?.name === 'string'
      && header.name.toLowerCase() === name.toLowerCase(),
  )
  return typeof match?.value === 'string' ? match.value : ''
}

const splitAddressList = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

const decodeBase64Url = (value: string): string =>
  Buffer.from(value, 'base64url').toString('utf8')

type GmailPart = {
  mimeType?: unknown
  filename?: unknown
  body?: { attachmentId?: unknown; data?: unknown; size?: unknown }
  parts?: GmailPart[]
}

const inlineDataHash = (data: string): string =>
  createHash('sha256').update(Buffer.from(data, 'base64url')).digest('hex')

const collectBodyAndAttachments = (
  part: GmailPart | undefined,
  into: { body: string; attachments: GmailDraftContent['attachments'] },
): void => {
  if (!part) return
  const filename = typeof part.filename === 'string' ? part.filename : ''
  const mimeType = typeof part.mimeType === 'string' ? part.mimeType : ''
  if (filename.length > 0) {
    const attachmentId =
      typeof part.body?.attachmentId === 'string' && part.body.attachmentId.length > 0
        ? part.body.attachmentId
        : undefined
    const inlineHash = !attachmentId && typeof part.body?.data === 'string'
      ? inlineDataHash(part.body.data)
      : undefined
    if (!attachmentId && !inlineHash) {
      throw new Error('[comms-google] Gmail returned an attachment without stable content identity')
    }
    into.attachments.push({
      ...(attachmentId ? { attachmentId } : {}),
      ...(inlineHash ? { inlineDataHash: inlineHash } : {}),
      filename,
      mimeType,
      sizeBytes: typeof part.body?.size === 'number' ? part.body.size : 0,
    })
    return
  }
  if (mimeType === 'text/plain' && typeof part.body?.data === 'string') {
    if (into.body.length === 0) {
      into.body = decodeBase64Url(part.body.data)
    }
    return
  }
  for (const child of part.parts ?? []) {
    collectBodyAndAttachments(child, into)
  }
}

export const getGmailDraft = async (
  fetchImpl: FetchLike,
  accessToken: string,
  draftId: string,
): Promise<GmailDraftContent> => {
  const { body } = await requestJson(
    fetchImpl,
    'drafts.get',
    `${GMAIL_API_BASE}/drafts/${encodeURIComponent(draftId)}?format=full`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  )
  const draft = body as {
    id?: unknown
    message?: {
      id?: unknown
      threadId?: unknown
      payload?: GmailPart & { headers?: { name?: unknown; value?: unknown }[] }
    }
  }
  if (typeof draft?.id !== 'string' || typeof draft.message?.id !== 'string') {
    throw new Error('[comms-google] Gmail returned a draft with no id')
  }
  const payload = draft.message.payload
  const headers = payload?.headers ?? []
  const collected = { body: '', attachments: [] as GmailDraftContent['attachments'] }
  collectBodyAndAttachments(payload, collected)

  return {
    id: draft.id,
    messageId: draft.message.id,
    ...(typeof draft.message.threadId === 'string'
      ? { threadId: draft.message.threadId }
      : {}),
    to: splitAddressList(headerValue(headers, 'To')),
    cc: splitAddressList(headerValue(headers, 'Cc')),
    bcc: splitAddressList(headerValue(headers, 'Bcc')),
    subject: headerValue(headers, 'Subject'),
    body: collected.body,
    attachments: collected.attachments,
  }
}

export const deleteGmailDraft = async (
  fetchImpl: FetchLike,
  accessToken: string,
  draftId: string,
): Promise<void> => {
  await requestJson(
    fetchImpl,
    'drafts.delete',
    `${GMAIL_API_BASE}/drafts/${encodeURIComponent(draftId)}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${accessToken}` } },
  )
}

/** Send an existing draft. Returns the sent message id. */
export const sendGmailDraft = async (
  fetchImpl: FetchLike,
  accessToken: string,
  draftId: string,
): Promise<{ messageId: string; threadId?: string }> => {
  const { body } = await requestJson(
    fetchImpl,
    'drafts.send',
    `${GMAIL_API_BASE}/drafts/send`,
    {
      method: 'POST',
      headers: bearer(accessToken),
      body: JSON.stringify({ id: draftId }),
    },
  )
  const sent = body as { id?: unknown; threadId?: unknown }
  if (typeof sent?.id !== 'string') {
    throw new Error('[comms-google] Gmail returned no sent message id')
  }
  return {
    messageId: sent.id,
    ...(typeof sent.threadId === 'string' ? { threadId: sent.threadId } : {}),
  }
}

/**
 * Send directly, without a draft. This is the only send `gmail.send` can do,
 * and it is deliberately a separate function from the draft path so a
 * send-only grant cannot accidentally travel through draft code.
 */
export const sendGmailMessage = async (
  fetchImpl: FetchLike,
  accessToken: string,
  message: OutboundMessage,
  threadId?: string,
): Promise<{ messageId: string; threadId?: string }> => {
  const { body } = await requestJson(
    fetchImpl,
    'messages.send',
    `${GMAIL_API_BASE}/messages/send`,
    {
      method: 'POST',
      headers: bearer(accessToken),
      body: JSON.stringify({
        raw: buildRawMessage(message),
        ...(threadId ? { threadId } : {}),
      }),
    },
  )
  const sent = body as { id?: unknown; threadId?: unknown }
  if (typeof sent?.id !== 'string') {
    throw new Error('[comms-google] Gmail returned no sent message id')
  }
  return {
    messageId: sent.id,
    ...(typeof sent.threadId === 'string' ? { threadId: sent.threadId } : {}),
  }
}
