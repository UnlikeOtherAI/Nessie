import { z } from 'zod'

import { BoardSourceProviderSchema } from './board-sources.js'
import { AgentIdSchema, TaskIdSchema, UserIdSchema } from './ids.js'
import { TimestampSchema } from './schema-primitives.js'
import { TASK_ATTACHMENT_LINK_MAX, TaskAttachmentRecordSchema } from './task-attachments.js'

/**
 * Ticket comments (data-model.md §1.4). A flat thread; the author is a person,
 * an agent, or — for an imported comment no identity link resolves — the
 * provider's own display data about its own user. People and agents are ids
 * only; the client resolves names and avatars.
 */
export const TaskCommentAuthorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: UserIdSchema }),
  z.object({ kind: z.literal('agent'), agentId: AgentIdSchema }),
  z.object({
    kind: z.literal('external'),
    provider: BoardSourceProviderSchema,
    externalUserId: z.string(),
    displayName: z.string(),
  }),
])
export type TaskCommentAuthor = z.infer<typeof TaskCommentAuthorSchema>

export const TASK_COMMENT_MAX_CHARS = 20_000

export const TaskCommentRecordSchema = z.object({
  id: z.string().uuid(),
  taskId: TaskIdSchema,
  author: TaskCommentAuthorSchema,
  /** Markdown; empty once deleted (deleted rows are not listed). */
  body: z.string(),
  attachments: z.array(TaskAttachmentRecordSchema),
  external: z
    .object({
      sourceId: z.string().uuid(),
      provider: BoardSourceProviderSchema,
      externalId: z.string(),
      url: z.string().nullable(),
    })
    .nullable(),
  /** Decided server-side from the author rule and the source's write mode. */
  viewerCanEdit: z.boolean(),
  viewerCanDelete: z.boolean(),
  createdAt: TimestampSchema,
  editedAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
})
export type TaskCommentRecord = z.infer<typeof TaskCommentRecordSchema>

export const TaskCommentListSchema = z.object({
  comments: z.array(TaskCommentRecordSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int(),
})
export type TaskCommentList = z.infer<typeof TaskCommentListSchema>

export const CreateTaskCommentBodySchema = z
  .object({
    body: z.string().min(1).max(TASK_COMMENT_MAX_CHARS),
    attachmentIds: z.array(z.string().uuid()).max(TASK_ATTACHMENT_LINK_MAX).optional(),
  })
  .strict()
export type CreateTaskCommentBody = z.infer<typeof CreateTaskCommentBodySchema>

export const UpdateTaskCommentBodySchema = z
  .object({
    body: z.string().min(1).max(TASK_COMMENT_MAX_CHARS),
  })
  .strict()
export type UpdateTaskCommentBody = z.infer<typeof UpdateTaskCommentBodySchema>
