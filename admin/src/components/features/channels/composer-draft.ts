import { detectSecrets } from '@nessie/schemas'

import { draftKey } from '../../../navigation/useDraft'
import type { StagedAttachment } from './useComposerAttachments'

/**
 * The unsent state of one composer: the text plus the *metadata* of files
 * already uploaded for it. Bytes are never stored — a finished upload already
 * lives server-side behind its `attachmentId`, which is the only thing a
 * restored draft needs to attach it to the eventual send.
 */
export type ComposerDraft = {
  attachments: StagedAttachment[]
  text: string
}

export const emptyComposerDraft: ComposerDraft = { attachments: [], text: '' }

/** `draft:composer:<channelId>` — one draft per channel, never per screen. */
export const channelComposerDraftKey = (channelId: string | null | undefined) =>
  draftKey('composer', channelId)

/** `draft:reply:<rootMessageId>` — a reply thread is its own conversation. */
export const replyComposerDraftKey = (rootMessageId: string | null | undefined) =>
  draftKey('reply', rootMessageId)

/**
 * Nothing to store. A draft carrying a detected credential counts as nothing
 * on purpose: the composer already refuses to send one, and persisting it
 * would put the material on disk in the one place the send path is built to
 * keep it out of. The same predicate also deletes a row a previous keystroke
 * wrote before the secret was complete enough to detect.
 */
export const composerDraftIsEmpty = (draft: ComposerDraft): boolean =>
  (draft.text.trim().length === 0 && draft.attachments.length === 0)
  || detectSecrets(draft.text).length > 0

/**
 * Only a finished upload survives a reload: an entry still uploading belongs to
 * the mount that started it, and a failed one has nothing on the server.
 */
export const storableComposerAttachments = (
  staged: StagedAttachment[],
): StagedAttachment[] =>
  staged.filter((entry) => entry.status === 'done' && Boolean(entry.attachmentId))

export const composerAttachmentIdsMatch = (
  left: StagedAttachment[],
  right: StagedAttachment[],
): boolean =>
  left.length === right.length
  && left.every((entry, index) => entry.attachmentId === right[index]?.attachmentId)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Storage is untrusted input: a hand-edited row must not reach the send. */
export const reviveComposerDraft = (stored: unknown): ComposerDraft | null => {
  if (!isRecord(stored)) {
    return null
  }
  const text = typeof stored.text === 'string' ? stored.text : ''
  if (detectSecrets(text).length > 0) {
    return null
  }
  const attachments = Array.isArray(stored.attachments)
    ? stored.attachments.flatMap((entry): StagedAttachment[] => {
      if (!isRecord(entry)) {
        return []
      }
      const { attachmentId, clientId, filename, sizeBytes } = entry
      if (
        typeof attachmentId !== 'string'
        || typeof clientId !== 'string'
        || typeof filename !== 'string'
        || typeof sizeBytes !== 'number'
        || detectSecrets(filename).length > 0
      ) {
        return []
      }
      return [{ attachmentId, clientId, filename, pct: 100, sizeBytes, status: 'done' }]
    })
    : []
  return text.length === 0 && attachments.length === 0 ? null : { attachments, text }
}
