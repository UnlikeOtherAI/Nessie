import { z } from 'zod'

import { BoardSourceProviderSchema } from './board-sources.js'
import { TaskIdSchema, UserIdSchema } from './ids.js'
import { TimestampSchema } from './schema-primitives.js'

/**
 * Files on a ticket (data-model.md §1.4). One row shape for everything the
 * Attachments section lists: a file uploaded in Nessie, a provider file the
 * sync stored, and a provider link (or a provider file the fetch gave up on),
 * which carries `external.status: 'link' | 'failed'` and the provider URL as
 * its `downloadPath` so the client renders an outbound link row.
 */
export const TaskAttachmentExternalStatusSchema = z.enum(['stored', 'failed', 'link'])
export type TaskAttachmentExternalStatus = z.infer<typeof TaskAttachmentExternalStatusSchema>

export const TaskAttachmentRecordSchema = z.object({
  /** The Attachment id; for a link row, the TaskExternalAsset id. */
  id: z.string().uuid(),
  taskId: TaskIdSchema,
  commentId: z.string().uuid().nullable(),
  filename: z.string(),
  mime: z.string(),
  /** FileService kind. */
  kind: z.string(),
  /** BigInt at the boundary. */
  sizeBytes: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  hasThumbnail: z.boolean(),
  uploaderUserId: UserIdSchema.nullable(),
  /** `/api/attachments/<id>`, or the provider URL for a link row. */
  downloadPath: z.string(),
  thumbnailPath: z.string().nullable(),
  /** Referenced from the description or a comment body (`![…](downloadPath)`). */
  inline: z.boolean(),
  external: z
    .object({
      sourceId: z.string().uuid(),
      provider: BoardSourceProviderSchema,
      externalUrl: z.string(),
      title: z.string().nullable(),
      status: TaskAttachmentExternalStatusSchema,
    })
    .nullable(),
  createdAt: TimestampSchema,
})
export type TaskAttachmentRecord = z.infer<typeof TaskAttachmentRecordSchema>

export const TaskAttachmentListSchema = z.object({
  attachments: z.array(TaskAttachmentRecordSchema),
})
export type TaskAttachmentList = z.infer<typeof TaskAttachmentListSchema>

export const TASK_ATTACHMENT_LINK_MAX = 10

/** Link uploads the caller made to a task (or, with a comment, to that comment). */
export const TaskAttachmentIdsSchema = z.array(z.string().uuid()).max(TASK_ATTACHMENT_LINK_MAX)

export const LinkTaskAttachmentsBodySchema = z
  .object({
    attachmentIds: z.array(z.string().uuid()).min(1).max(TASK_ATTACHMENT_LINK_MAX),
  })
  .strict()
export type LinkTaskAttachmentsBody = z.infer<typeof LinkTaskAttachmentsBodySchema>

/** The one URL form inline images take; the renderer and editor match it. */
export const INLINE_ATTACHMENT_PATH = /^\/api\/attachments\/([0-9a-f-]{36})$/

/** The inline-image path for an attachment id — what the editor inserts. */
export const inlineAttachmentPath = (attachmentId: string): string =>
  `/api/attachments/${attachmentId}`

// Fenced blocks (``` or ~~~, closed by the same fence or the end of the text)
// and inline code spans render verbatim, so a path inside them is text, not a
// reference.
const FENCED_CODE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm
const INLINE_CODE = /(`+)[\s\S]*?\1/g
// `![alt](dest "title")` and `[text](dest)`: the text may hold escaped
// brackets, the destination may be wrapped in `<…>`, and a title is optional.
const LINK_OR_IMAGE =
  /!?\[(?:\\.|[^\]\\])*\]\(\s*<?([^\s)<>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g

/**
 * The attachment ids a Markdown body references through the inline form —
 * images `![…](/api/attachments/<id>)` and links `[…](/api/attachments/<id>)`.
 * Unique, in first-reference order. A path inside code is not a reference, and
 * any other URL (a provider URL still pending import, an external image) is
 * ignored.
 */
export const inlineAttachmentIds = (markdown: string): string[] => {
  const text = markdown.replace(FENCED_CODE, '').replace(INLINE_CODE, '')
  const ids: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(LINK_OR_IMAGE)) {
    const destination = match[1]
    if (!destination) continue
    const id = INLINE_ATTACHMENT_PATH.exec(destination)?.[1]
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}
