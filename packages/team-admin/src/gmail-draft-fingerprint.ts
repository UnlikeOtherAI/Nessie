import { createHash } from 'node:crypto'

import {
  canonicalDraftFingerprintInput,
  type GmailDraftContent,
  type OutboundMessage,
} from '@nessie/comms-google'

export const fingerprintDraft = (input: {
  to: readonly string[]
  cc?: readonly string[]
  bcc?: readonly string[]
  subject: string
  body: string
  inReplyTo?: string
  references?: readonly string[]
  threadId?: string
  attachmentIds?: readonly string[]
}): string =>
  createHash('sha256')
    .update(canonicalDraftFingerprintInput(input))
    .digest('hex')

export const fingerprintOf = (draft: GmailDraftContent): string =>
  fingerprintDraft({
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: draft.body,
    inReplyTo: draft.inReplyTo,
    references: draft.references,
    threadId: draft.threadId,
    attachmentIds: draft.attachments.map((attachment) => `${attachment.filename}:${attachment.sizeBytes}`),
  })

export const fingerprintMessage = (message: OutboundMessage, threadId?: string): string =>
  fingerprintDraft({
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    body: message.body,
    inReplyTo: message.inReplyTo,
    references: message.references,
    threadId,
    attachmentIds: (message.attachments ?? []).map((attachment) =>
      `${attachment.filename}:${attachment.content.byteLength}`),
  })
