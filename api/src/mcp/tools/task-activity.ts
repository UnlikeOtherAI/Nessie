import { Readable } from 'node:stream'

import { z } from 'zod'
import {
  attributionFromActorContext,
  collectStream,
  FileTooLargeError,
  QuotaExceededError,
} from '@nessie/runtime'
import {
  detectSecrets,
  inlineAttachmentPath,
  TASK_COMMENT_MAX_CHARS,
  type TaskAttachmentRecord,
} from '@nessie/schemas'
import { publishTaskActivity } from '@nessie/team-admin'

import {
  linkTaskAttachments,
  listTaskAttachments,
  removeTaskAttachment,
} from '../../services/task-attachments.js'
import {
  createTaskComment,
  createTaskCommentWriteBack,
  deleteTaskComment,
  listTaskComments,
  updateTaskComment,
} from '../../services/task-comments.js'
import { taskActorFromContext } from '../../services/task-labels.js'
import { requireScope } from '../scopes.js'
import type { McpToolContext, McpToolDefinition, TaskWithOrigin } from '../tool-context.js'
import {
  describeOrigin,
  describeWriteFailure,
  MARKDOWN_NOTE,
  TASK_NOT_REACHABLE,
} from './boards.js'
import { providerName } from './labels.js'

/**
 * A task's comments and files.
 *
 * Every tool re-reads the task through `context.getTask` — the task routes'
 * visibility narrowing, run-derived disclosure included — and then calls the
 * very function the comment and attachment routes call, with the same actor
 * a route builds. So an agent's comment is the granting person's comment,
 * refused, audited and propagated exactly as theirs would be, and it announces
 * itself on the same `task.activity` event so an open dialog refreshes.
 */

/** The decoded ceiling for a file handed over inline as base64. */
export const MCP_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
/** The run-context image cap: bytes inlined on read only up to this size. */
export const MCP_ATTACHMENT_INLINE_MAX_BYTES = 4 * 1024 * 1024

const FILE_STORAGE_UNAVAILABLE = 'File storage is not available on this Nessie instance.'

const reachableTask = async (
  context: McpToolContext,
  taskId: string,
): Promise<TaskWithOrigin | null> => context.getTask(taskId)

const announce = async (
  context: McpToolContext,
  taskId: string,
  projectId: string | null,
): Promise<void> => {
  if (!context.realtime) return
  await publishTaskActivity(context.realtime, {
    organizationId: context.actorContext.tenant.organizationId,
    taskId,
    projectId,
  })
}

/**
 * Why a new comment did not reach the ticket's external system, in words, or
 * null when it did (or the ticket is Nessie's own).
 */
const propagationNote = (task: TaskWithOrigin, propagated: boolean): string | null => {
  const link = task.externalLink
  if (!link || propagated) return null
  const provider = providerName(link.provider)
  return link.writeMode === 'read_write'
    ? `${provider} cannot take comments from Nessie; the comment stays in Nessie.`
    : `This ticket mirrors ${provider} read-only; the comment stays in Nessie.`
}

/** The decoded size of a base64 string, without decoding it. */
const decodedSize = (base64: string): number => {
  const trimmed = base64.replace(/\s/g, '')
  const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0
  return Math.floor((trimmed.length * 3) / 4) - padding
}

const inlinable = (attachment: TaskAttachmentRecord): boolean =>
  (attachment.mime.startsWith('image/') || attachment.mime.startsWith('text/'))
  && Number(attachment.sizeBytes) <= MCP_ATTACHMENT_INLINE_MAX_BYTES

const TaskIdSchema = z.string().uuid()
const CommentBodySchema = z.string().min(1).max(TASK_COMMENT_MAX_CHARS)

export const taskActivityTools = (): McpToolDefinition[] => [
  {
    description:
      "Read a task's comments, oldest first, 50 per page by default (up to "
      + '100). Pass `nextCursor` back as `cursor` for the next page. An author '
      + 'is a person (`userId`), an agent (`agentId`) or a person in an '
      + 'external system (`displayName`); a person is named by id only. '
      + `Comment bodies are Markdown. ${MARKDOWN_NOTE}`,
    inputSchema: {
      cursor: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      taskId: TaskIdSchema,
    },
    name: 'nessie_task_comment_list',
    run: async (context, input) => {
      requireScope(context.scopes, 'boards_read')
      const task = await reachableTask(context, input.taskId as string)
      if (!task) return { error: TASK_NOT_REACHABLE }
      const result = await listTaskComments(context.prisma, taskActorFromContext(context.actorContext), {
        taskId: task.id,
        ...(input.cursor ? { cursor: input.cursor as string } : {}),
        ...(input.limit ? { limit: input.limit as number } : {}),
      })
      if ('error' in result) return describeWriteFailure(result)
      return result
    },
  },
  {
    description:
      'Add a comment to a task, as the person who approved this credential. '
      + 'On a task mirrored from an external system with read & write access '
      + 'the comment is posted there too; otherwise it stays in Nessie and the '
      + `result says so (\`propagated: false\`). ${MARKDOWN_NOTE}`,
    inputSchema: {
      body: CommentBodySchema,
      taskId: TaskIdSchema,
    },
    name: 'nessie_task_comment_add',
    run: async (context, input) => {
      requireScope(context.scopes, 'boards_write')
      const task = await reachableTask(context, input.taskId as string)
      if (!task) return { error: TASK_NOT_REACHABLE }
      const result = await createTaskComment(
        context.prisma,
        taskActorFromContext(context.actorContext),
        { taskId: task.id, body: input.body as string },
        { writeBack: createTaskCommentWriteBack(context.prisma, context.encryptionKeyRing) },
      )
      if ('error' in result) return describeWriteFailure(result)
      await announce(context, task.id, result.projectId)
      const note = propagationNote(task, result.propagated)
      return {
        comment: result.comment,
        origin: describeOrigin(task.externalLink),
        propagated: result.propagated,
        ...(note ? { note } : {}),
      }
    },
  },
  {
    description:
      "Change a comment's text. Only its author can change a comment; on a "
      + 'mirrored task the change is made in the external system first. '
      + `${MARKDOWN_NOTE}`,
    inputSchema: {
      body: CommentBodySchema,
      commentId: z.string().uuid(),
      taskId: TaskIdSchema,
    },
    name: 'nessie_task_comment_update',
    run: async (context, input) => {
      requireScope(context.scopes, 'boards_write')
      const task = await reachableTask(context, input.taskId as string)
      if (!task) return { error: TASK_NOT_REACHABLE }
      const result = await updateTaskComment(
        context.prisma,
        taskActorFromContext(context.actorContext),
        { taskId: task.id, commentId: input.commentId as string, body: input.body as string },
        { writeBack: createTaskCommentWriteBack(context.prisma, context.encryptionKeyRing) },
      )
      if ('error' in result) return describeWriteFailure(result)
      await announce(context, task.id, result.projectId)
      return { comment: result.comment }
    },
  },
  {
    description:
      'Delete a comment, and the files attached to it. Only its author can '
      + 'delete a comment.',
    inputSchema: {
      commentId: z.string().uuid(),
      taskId: TaskIdSchema,
    },
    name: 'nessie_task_comment_delete',
    run: async (context, input) => {
      requireScope(context.scopes, 'boards_write')
      const task = await reachableTask(context, input.taskId as string)
      if (!task) return { error: TASK_NOT_REACHABLE }
      if (!context.fileService) return { error: FILE_STORAGE_UNAVAILABLE }
      const result = await deleteTaskComment(
        context.prisma,
        taskActorFromContext(context.actorContext),
        { taskId: task.id, commentId: input.commentId as string },
        {
          fileService: context.fileService,
          attribution: attributionFromActorContext(context.actorContext),
          writeBack: createTaskCommentWriteBack(context.prisma, context.encryptionKeyRing),
        },
      )
      if ('error' in result) return describeWriteFailure(result)
      await announce(context, task.id, result.projectId)
      return { deleted: true }
    },
  },
  {
    description:
      "List a task's files, newest first: files stored in Nessie (with "
      + '`inline: true` when the description or a comment shows it) and links '
      + 'to files an external system keeps. Read one with '
      + 'nessie_task_attachment_get.',
    inputSchema: { taskId: TaskIdSchema },
    name: 'nessie_task_attachment_list',
    run: async (context, input) => {
      requireScope(context.scopes, 'boards_read')
      const task = await reachableTask(context, input.taskId as string)
      if (!task) return { error: TASK_NOT_REACHABLE }
      const result = await listTaskAttachments(
        context.prisma,
        taskActorFromContext(context.actorContext),
        { taskId: task.id },
      )
      if ('error' in result) return describeWriteFailure(result)
      return result
    },
  },
  {
    description:
      'Attach a file to a task, sent as base64 (at most 10 MiB decoded). '
      + 'The result carries `markdown`, the reference to paste into the '
      + 'description (nessie_task_update `detail`) or a comment to show an '
      + 'image inline: `![alt](/api/attachments/<attachmentId>)`.',
    inputSchema: {
      contentBase64: z.string().min(1),
      filename: z.string().trim().min(1).max(255),
      mime: z.string().trim().min(1).max(255),
      taskId: TaskIdSchema,
    },
    name: 'nessie_task_attachment_add',
    run: async (context, input) => {
      requireScope(context.scopes, 'boards_write')
      const task = await reachableTask(context, input.taskId as string)
      if (!task) return { error: TASK_NOT_REACHABLE }
      if (!context.fileService) return { error: FILE_STORAGE_UNAVAILABLE }
      const content = input.contentBase64 as string
      if (decodedSize(content) > MCP_ATTACHMENT_MAX_BYTES) {
        return describeWriteFailure({
          error: 'ATTACHMENT_TOO_LARGE',
          detail: 'Files attached through MCP are limited to 10 MiB.',
        })
      }
      const bytes = Buffer.from(content, 'base64')
      if (bytes.byteLength === 0) return { error: 'contentBase64 decoded to zero bytes.' }
      if (bytes.byteLength > MCP_ATTACHMENT_MAX_BYTES) {
        return describeWriteFailure({
          error: 'ATTACHMENT_TOO_LARGE',
          detail: 'Files attached through MCP are limited to 10 MiB.',
        })
      }
      // The upload route's own gate: a credential pasted into a file is
      // stopped before it is stored anywhere a project can read it.
      if (detectSecrets(bytes.toString('utf8')).length > 0) {
        return {
          error: 'A possible credential was found in this file, so it was not stored.',
          retryable: false,
        }
      }

      const actor = taskActorFromContext(context.actorContext)
      const attribution = attributionFromActorContext(context.actorContext)
      let attachmentId: string
      try {
        const { attachment } = await context.fileService.store({
          attribution,
          organizationId: actor.organizationId,
          uploaderId: actor.userId,
          filename: input.filename as string,
          mime: input.mime as string,
          body: Readable.from(bytes),
        })
        attachmentId = attachment.id
      } catch (error) {
        if (error instanceof QuotaExceededError || error instanceof FileTooLargeError) {
          return { error: error.message, retryable: false }
        }
        throw error
      }
      // Linked through the task's own door, so it is audited and counted as
      // a person's upload would be — an agent has no composer to stage into,
      // so its file joins the task the moment it exists.
      const linked = await linkTaskAttachments(context.prisma, actor, {
        taskId: task.id,
        attachmentIds: [attachmentId],
      })
      const attachment = 'error' in linked ? undefined : linked.attachments[0]
      if (!attachment) {
        await context.fileService.delete(attachmentId, actor.organizationId, attribution)
        return { error: TASK_NOT_REACHABLE }
      }
      await announce(context, task.id, 'error' in linked ? null : linked.projectId)
      const alt = attachment.filename.replace(/[[\]]/g, '')
      return { attachment, markdown: `![${alt}](${inlineAttachmentPath(attachment.id)})` }
    },
  },
  {
    description:
      "Read one of a task's files. Images and text files up to 4 MiB come back "
      + 'as `contentBase64`; anything else returns its details only, and a '
      + 'person can download it from the task in Nessie.',
    inputSchema: {
      attachmentId: z.string().uuid(),
      taskId: TaskIdSchema,
    },
    name: 'nessie_task_attachment_get',
    run: async (context, input) => {
      requireScope(context.scopes, 'boards_read')
      const task = await reachableTask(context, input.taskId as string)
      if (!task) return { error: TASK_NOT_REACHABLE }
      const listed = await listTaskAttachments(
        context.prisma,
        taskActorFromContext(context.actorContext),
        { taskId: task.id },
      )
      if ('error' in listed) return describeWriteFailure(listed)
      const attachment = listed.attachments.find((candidate) => candidate.id === input.attachmentId)
      if (!attachment) return describeWriteFailure({ error: 'ATTACHMENT_NOT_ON_TASK' })
      if (attachment.kind === 'link') {
        return { attachment, note: 'This file is kept by an external system; `downloadPath` is its link.' }
      }
      if (!inlinable(attachment)) {
        return {
          attachment,
          note: 'Only images and text files up to 4 MiB are returned through MCP. '
            + 'A person can download this one from the task in Nessie.',
        }
      }
      if (!context.fileService) return { attachment, error: FILE_STORAGE_UNAVAILABLE }
      const opened = await context.fileService.openStream(
        attachment.id,
        context.actorContext.tenant.organizationId,
      )
      if (!opened) return { attachment, error: 'The stored bytes of this file are missing.' }
      const bytes = await collectStream(opened.stream)
      return { attachment, contentBase64: bytes.toString('base64') }
    },
  },
  {
    description:
      'Remove a file from a task and delete it. The person who uploaded it, '
      + 'or any member of the project, can remove it.',
    inputSchema: {
      attachmentId: z.string().uuid(),
      taskId: TaskIdSchema,
    },
    name: 'nessie_task_attachment_remove',
    run: async (context, input) => {
      requireScope(context.scopes, 'boards_write')
      const task = await reachableTask(context, input.taskId as string)
      if (!task) return { error: TASK_NOT_REACHABLE }
      if (!context.fileService) return { error: FILE_STORAGE_UNAVAILABLE }
      const result = await removeTaskAttachment(
        context.prisma,
        taskActorFromContext(context.actorContext),
        { taskId: task.id, attachmentId: input.attachmentId as string },
        {
          fileService: context.fileService,
          attribution: attributionFromActorContext(context.actorContext),
        },
      )
      if ('error' in result) return describeWriteFailure(result)
      await announce(context, task.id, result.projectId)
      return { removed: true }
    },
  },
]
