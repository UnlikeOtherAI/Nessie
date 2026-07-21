import type { EventAttachment } from '@nessie/comms-connect'

/**
 * The subset of a Gmail `users.messages.get` (format=full) payload the
 * connector reads. Only fields we normalize are typed; everything else is
 * ignored. A payload is a tree of MIME parts, each optionally carrying inline
 * body data (base64url) or an attachment reference.
 */
export type GmailHeader = { name?: string; value?: string }

export type GmailMessagePart = {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: {
    size?: number
    data?: string
    attachmentId?: string
  }
  parts?: GmailMessagePart[]
}

export type GmailMessage = {
  id: string
  threadId: string
  labelIds?: string[]
  internalDate?: string
  snippet?: string
  historyId?: string
  payload?: GmailMessagePart
}

/**
 * A case-insensitive lookup over a part's headers. Gmail header names are
 * case-preserving but not case-stable, so From/FROM/from all resolve.
 */
export const buildHeaderIndex = (
  headers: GmailHeader[] | undefined,
): Map<string, string> => {
  const index = new Map<string, string>()
  for (const header of headers ?? []) {
    if (header.name && typeof header.value === 'string') {
      index.set(header.name.toLowerCase(), header.value)
    }
  }
  return index
}

/** Decode a Gmail base64url body segment to a UTF-8 string. */
export const decodeBody = (data: string | undefined): string | undefined => {
  if (!data) {
    return undefined
  }
  return Buffer.from(data, 'base64url').toString('utf8')
}

/**
 * Depth-first search for the first `text/plain` part's decoded text. Prefers a
 * top-level text/plain, then recurses into multipart containers (e.g.
 * multipart/alternative). Never touches attachment parts.
 */
export const extractPlainTextBody = (
  part: GmailMessagePart | undefined,
): string | undefined => {
  if (!part) {
    return undefined
  }
  const mimeType = part.mimeType ?? ''
  if (mimeType === 'text/plain' && !part.filename) {
    const text = decodeBody(part.body?.data)
    if (text !== undefined) {
      return text
    }
  }
  for (const child of part.parts ?? []) {
    const found = extractPlainTextBody(child)
    if (found !== undefined) {
      return found
    }
  }
  return undefined
}

/**
 * Walk the whole part tree collecting attachment METADATA ONLY — a part is an
 * attachment when it has a filename and an `attachmentId`. The bytes are never
 * fetched here; only filename, MIME type, size, and the provider attachmentId
 * (kept as {@link EventAttachment.externalId}) are recorded.
 */
export const collectAttachments = (
  part: GmailMessagePart | undefined,
): EventAttachment[] => {
  const out: EventAttachment[] = []
  const visit = (node: GmailMessagePart | undefined): void => {
    if (!node) {
      return
    }
    if (node.filename && node.body?.attachmentId) {
      out.push({
        externalId: node.body.attachmentId,
        name: node.filename,
        mimeType: node.mimeType,
        sizeBytes: node.body.size,
      })
    }
    for (const child of node.parts ?? []) {
      visit(child)
    }
  }
  visit(part)
  return out
}
