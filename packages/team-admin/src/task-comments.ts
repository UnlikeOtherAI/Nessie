import type { Prisma, PrismaClient } from '@prisma/client'
import type { NormalisedComment } from '@nessie/board-sources'
import {
  COMMENT_REMOVAL_REASON,
  inlineAttachmentIds,
  parseAgentId,
  parseTaskId,
  parseUserId,
  type TaskCommentAuthor,
  type TaskCommentList,
  type TaskCommentRecord,
} from '@nessie/schemas'

import type { BoardSourceCommentWriteBackError as BoardSourceWriteBackError } from './board-source-writeback.js'
import { findAccessibleTask, isUuid, SYSTEM_TASK_EVENT_ORIGIN, taskEventBy, type TaskActor } from './task-access.js'
import { recordTaskEvent } from './task-event-dispatch.js'
import { applyTicketWorkAgentComment } from './ticket-work-clock.js'
import {
  attachmentRemover,
  linkUploadsToTask,
  mapTaskAttachment,
  recordAttachmentsAdded,
  taskAttachmentSelect,
} from './task-attachments.js'

/**
 * A ticket's flat comment thread. A comment belongs to its author — the
 * person, or the agent whose run wrote it — and only the author edits or
 * deletes it (the `softDeleteMessage` rule). Deletion is soft: the body is
 * blanked, `deletedAt` set, and the comment's files are marked removed —
 * they stay on the ticket, downloadable, like any removed file.
 */

/**
 * The provider half of a comment on a mirrored ticket. Each method returns
 * the provider's echo, a refusal, or null when the ticket is not mirrored.
 * An absent method means the adapter cannot do that write: a new comment then
 * stays Nessie-only, and an edit or delete of an imported one is refused
 * `COMMENT_NOT_WRITABLE`. Only called for a `read_write` source.
 */
export type TaskCommentWriteBack = {
  createComment?: (input: { taskId: string; body: string }) => Promise<
    { ok: true; comment: NormalisedComment } | BoardSourceWriteBackError | null
  >
  updateComment?: (input: { taskId: string; commentId: string; externalId: string; body: string }) => Promise<
    { ok: true; comment: NormalisedComment } | BoardSourceWriteBackError | null
  >
  deleteComment?: (input: { taskId: string; commentId: string; externalId: string }) => Promise<
    { ok: true } | BoardSourceWriteBackError | null
  >
}

export type TaskCommentError =
  | { error: 'NOT_FOUND' }
  | { error: 'COMMENT_NOT_FOUND' }
  | { error: 'COMMENT_NOT_AUTHOR' }
  | { error: 'COMMENT_NOT_WRITABLE' }
  | { error: 'CURSOR_INVALID' }

const commentSelect = {
  id: true,
  taskId: true,
  authorUserId: true,
  authorAgentId: true,
  externalAuthorExternalId: true,
  externalAuthorDisplay: true,
  body: true,
  sourceId: true,
  externalId: true,
  externalUrl: true,
  editedAt: true,
  createdAt: true,
  updatedAt: true,
  source: { select: { provider: true, writeMode: true } },
} satisfies Prisma.TaskCommentSelect

type CommentRow = Prisma.TaskCommentGetPayload<{ select: typeof commentSelect }>

/** A comment is the actor's when the same agent, or (no agent) the same person, wrote it. */
export const isTaskCommentAuthor = (
  actor: Pick<TaskActor, 'userId' | 'agentId'>,
  comment: { authorUserId: string | null; authorAgentId: string | null },
): boolean =>
  actor.agentId
    ? comment.authorAgentId === actor.agentId
    : comment.authorUserId !== null && comment.authorUserId === actor.userId

const authorOf = (row: CommentRow): TaskCommentAuthor | null => {
  if (row.authorUserId) return { kind: 'user', userId: parseUserId(row.authorUserId) }
  if (row.authorAgentId) return { kind: 'agent', agentId: parseAgentId(row.authorAgentId) }
  if (row.source) {
    return {
      kind: 'external',
      provider: row.source.provider,
      externalUserId: row.externalAuthorExternalId ?? '',
      displayName: row.externalAuthorDisplay ?? 'Unknown',
    }
  }
  return null
}

/**
 * Shown only when some author is expressible: a Nessie comment whose author
 * row was deleted has none, and is left out rather than shown as nobody's.
 */
const listableWhere: Prisma.TaskCommentWhereInput = {
  deletedAt: null,
  OR: [{ authorUserId: { not: null } }, { authorAgentId: { not: null } }, { sourceId: { not: null } }],
}

const mapComment = (
  row: CommentRow,
  actor: TaskActor,
  attachments: Prisma.AttachmentGetPayload<{ select: typeof taskAttachmentSelect }>[],
): TaskCommentRecord | null => {
  const author = authorOf(row)
  if (!author) return null
  const mine = isTaskCommentAuthor(actor, row)
  // An imported comment is only writable through a read & write source.
  const writable = row.sourceId === null || row.source?.writeMode === 'read_write'
  const inlineIds = new Set(inlineAttachmentIds(row.body))
  return {
    id: row.id,
    taskId: parseTaskId(row.taskId),
    author,
    body: row.body,
    attachments: attachments.map((attachment) => mapTaskAttachment(attachment, { inlineIds })),
    external:
      row.sourceId && row.source && row.externalId
        ? {
            sourceId: row.sourceId,
            provider: row.source.provider,
            externalId: row.externalId,
            url: row.externalUrl,
          }
        : null,
    viewerCanEdit: mine && writable,
    viewerCanDelete: mine && writable,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

const mapWithAttachments = async (
  prisma: PrismaClient,
  actor: TaskActor,
  rows: CommentRow[],
): Promise<TaskCommentRecord[]> => {
  const attachments = rows.length === 0
    ? []
    : await prisma.attachment.findMany({
        where: { taskCommentId: { in: rows.map((row) => row.id) } },
        select: taskAttachmentSelect,
        orderBy: { createdAt: 'asc' },
      })
  return rows.flatMap((row) => {
    const record = mapComment(
      row,
      actor,
      attachments.filter((attachment) => attachment.taskCommentId === row.id),
    )
    return record ? [record] : []
  })
}

const encodeCursor = (row: { createdAt: Date; id: string }): string =>
  Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url')

const decodeCursor = (cursor: string): { createdAt: Date; id: string } | null => {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
  const createdAt = new Date(iso ?? '')
  if (!id || !isUuid(id) || Number.isNaN(createdAt.getTime())) return null
  return { createdAt, id }
}

export const TASK_COMMENT_PAGE_DEFAULT = 50
export const TASK_COMMENT_PAGE_MAX = 100

/** Oldest first, keyset on `(createdAt, id)`; `total` counts live comments only. */
export const listTaskComments = async (
  prisma: PrismaClient,
  actor: TaskActor,
  input: { taskId: string; cursor?: string | null; limit?: number },
): Promise<TaskCommentList | TaskCommentError> => {
  const task = await findAccessibleTask(prisma, actor, input.taskId)
  if (!task) return { error: 'NOT_FOUND' }
  const after = input.cursor ? decodeCursor(input.cursor) : null
  if (input.cursor && !after) return { error: 'CURSOR_INVALID' }
  const limit = Math.min(Math.max(input.limit ?? TASK_COMMENT_PAGE_DEFAULT, 1), TASK_COMMENT_PAGE_MAX)
  const where: Prisma.TaskCommentWhereInput = { taskId: task.id, ...listableWhere }
  const [rows, total] = await Promise.all([
    prisma.taskComment.findMany({
      where: after
        ? {
            AND: [
              where,
              {
                OR: [
                  { createdAt: { gt: after.createdAt } },
                  { createdAt: after.createdAt, id: { gt: after.id } },
                ],
              },
            ],
          }
        : where,
      select: commentSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    }),
    prisma.taskComment.count({ where }),
  ])
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    comments: await mapWithAttachments(prisma, actor, page),
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    total,
  }
}

const readComment = async (prisma: PrismaClient, actor: TaskActor, id: string) => {
  const [record] = await mapWithAttachments(prisma, actor, [
    await prisma.taskComment.findUniqueOrThrow({ where: { id }, select: commentSelect }),
  ])
  if (!record) throw new Error(`comment ${id} has no expressible author`)
  return record
}

/**
 * Add a comment, optionally with the actor's own uploads. On a `read_write`
 * mirrored ticket whose adapter can post comments, the provider is asked
 * first and the row is written from its echo (so it carries `externalId`);
 * otherwise the comment is Nessie-only.
 */
export const createTaskComment = async (
  prisma: PrismaClient,
  actor: TaskActor,
  input: {
    taskId: string
    body: string
    attachmentIds?: readonly string[]
    /**
     * An agent's comment asks the people on the ticket something
     * (`ticket_comment_add`'s `awaitsAnswer`): stamped on its `comment_added`
     * event, and it opens the question on the agent's live work for the ticket.
     */
    awaitsAnswer?: boolean
  },
  deps: { writeBack?: TaskCommentWriteBack } = {},
): Promise<
  | { comment: TaskCommentRecord; projectId: string | null; propagated: boolean }
  | TaskCommentError
  | BoardSourceWriteBackError
> => {
  const task = await findAccessibleTask(prisma, actor, input.taskId)
  if (!task) return { error: 'NOT_FOUND' }
  let echo: NormalisedComment | null = null
  const link = task.externalLink
  if (link && link.source.writeMode === 'read_write' && deps.writeBack?.createComment) {
    const outcome = await deps.writeBack.createComment({ taskId: task.id, body: input.body })
    if (outcome && 'error' in outcome) return outcome
    echo = outcome?.comment ?? null
  }
  const by = taskEventBy(actor)
  const author = {
    authorUserId: actor.agentId ? null : actor.userId,
    authorAgentId: actor.agentId ?? null,
  }
  const commentId = await prisma.$transaction(async (tx) => {
    const external = echo && link
      ? {
          sourceId: link.sourceId,
          externalId: echo.externalId,
          externalUrl: echo.url ?? null,
          externalUpdatedAt: new Date(echo.updatedAt),
        }
      : null
    const body = echo?.body ?? input.body
    // A webhook for our own post can land first; the row it wrote is ours.
    const comment = external
      ? await tx.taskComment.upsert({
          where: { sourceId_externalId: { sourceId: external.sourceId, externalId: external.externalId } },
          create: { organizationId: task.organizationId, taskId: task.id, body, ...author, ...external },
          update: { body, ...author, deletedAt: null },
          select: { id: true },
        })
      : await tx.taskComment.create({
          data: { organizationId: task.organizationId, taskId: task.id, body, ...author },
          select: { id: true },
        })
    await recordTaskEvent(tx, {
      taskId: task.id,
      eventType: 'comment_added',
      payload: {
        by,
        origin: actor.origin ?? SYSTEM_TASK_EVENT_ORIGIN,
        commentId: comment.id,
        ...(actor.agentId ? { agentId: actor.agentId } : {}),
        ...(external ? { externalId: external.externalId } : {}),
        ...(actor.agentId && input.awaitsAnswer ? { awaitsAnswer: true } : {}),
      },
      scope: { organizationId: task.organizationId, projectId: task.projectId },
    })
    // Only an agent's comment opens or closes the question on its own work.
    if (actor.agentId) {
      await applyTicketWorkAgentComment(tx, {
        taskId: task.id,
        agentId: actor.agentId,
        awaitsAnswer: input.awaitsAnswer === true,
      })
    }
    const linked = await linkUploadsToTask(tx, {
      organizationId: task.organizationId,
      uploaderUserId: actor.userId,
      taskId: task.id,
      commentId: comment.id,
      attachmentIds: input.attachmentIds ?? [],
    })
    await recordAttachmentsAdded(tx, { taskId: task.id, by, attachmentIds: linked, commentId: comment.id })
    return comment.id
  })
  return { comment: await readComment(prisma, actor, commentId), projectId: task.projectId, propagated: echo !== null }
}

type EditTarget =
  | { task: NonNullable<Awaited<ReturnType<typeof findAccessibleTask>>>; comment: CommentRow }
  | TaskCommentError
  | BoardSourceWriteBackError

/** The shared gate for edit and delete: visible task, live comment, the author, a writable home. */
const loadOwnComment = async (
  prisma: PrismaClient,
  actor: TaskActor,
  input: { taskId: string; commentId: string },
  writeBackMethod: keyof TaskCommentWriteBack,
  writeBack: TaskCommentWriteBack | undefined,
): Promise<EditTarget> => {
  const task = await findAccessibleTask(prisma, actor, input.taskId)
  if (!task) return { error: 'NOT_FOUND' }
  if (!isUuid(input.commentId)) return { error: 'COMMENT_NOT_FOUND' }
  const comment = await prisma.taskComment.findFirst({
    where: { id: input.commentId, taskId: task.id, deletedAt: null },
    select: commentSelect,
  })
  if (!comment) return { error: 'COMMENT_NOT_FOUND' }
  if (!isTaskCommentAuthor(actor, comment)) return { error: 'COMMENT_NOT_AUTHOR' }
  if (comment.sourceId && comment.source) {
    if (comment.source.writeMode === 'read_only') {
      return {
        error: 'SOURCE_READ_ONLY',
        provider: comment.source.provider,
        detail: 'This comment lives in a read-only source. Switch the source to read & write in Settings → Sources to change it from here.',
      }
    }
    if (!writeBack?.[writeBackMethod]) return { error: 'COMMENT_NOT_WRITABLE' }
  }
  return { task, comment }
}

/** Edit a comment's body. Author only; an imported comment is edited upstream first. */
export const updateTaskComment = async (
  prisma: PrismaClient,
  actor: TaskActor,
  input: { taskId: string; commentId: string; body: string },
  deps: { writeBack?: TaskCommentWriteBack } = {},
): Promise<
  { comment: TaskCommentRecord; projectId: string | null } | TaskCommentError | BoardSourceWriteBackError
> => {
  const target = await loadOwnComment(prisma, actor, input, 'updateComment', deps.writeBack)
  if ('error' in target) return target
  const { task, comment } = target
  let body = input.body
  let externalUpdatedAt: Date | undefined
  if (comment.sourceId && comment.externalId && deps.writeBack?.updateComment) {
    const outcome = await deps.writeBack.updateComment({
      taskId: task.id,
      commentId: comment.id,
      externalId: comment.externalId,
      body: input.body,
    })
    if (outcome && 'error' in outcome) return outcome
    if (outcome) {
      body = outcome.comment.body
      externalUpdatedAt = new Date(outcome.comment.updatedAt)
    }
  }
  await prisma.$transaction(async (tx) => {
    await tx.taskComment.update({
      where: { id: comment.id },
      data: { body, editedAt: new Date(), ...(externalUpdatedAt ? { externalUpdatedAt } : {}) },
    })
    await tx.taskEvent.create({
      data: { taskId: task.id, eventType: 'comment_edited', payload: { by: taskEventBy(actor), commentId: comment.id } },
    })
  })
  return { comment: await readComment(prisma, actor, comment.id), projectId: task.projectId }
}

/**
 * Delete a comment: author only, soft (body blanked, `deletedAt` set). Its
 * files are marked removed with the deleter as remover and
 * `COMMENT_REMOVAL_REASON`, one `attachment_removed` each; a file somebody
 * already removed keeps its first remover. No bytes are deleted.
 */
export const deleteTaskComment = async (
  prisma: PrismaClient,
  actor: TaskActor,
  input: { taskId: string; commentId: string },
  deps: { writeBack?: TaskCommentWriteBack } = {},
): Promise<{ ok: true; projectId: string | null } | TaskCommentError | BoardSourceWriteBackError> => {
  const target = await loadOwnComment(prisma, actor, input, 'deleteComment', deps.writeBack)
  if ('error' in target) return target
  const { task, comment } = target
  if (comment.sourceId && comment.externalId && deps.writeBack?.deleteComment) {
    const outcome = await deps.writeBack.deleteComment({
      taskId: task.id,
      commentId: comment.id,
      externalId: comment.externalId,
    })
    if (outcome && 'error' in outcome) return outcome
  }
  const by = taskEventBy(actor)
  await prisma.$transaction(async (tx) => {
    await tx.taskComment.update({
      where: { id: comment.id },
      data: { body: '', deletedAt: new Date() },
    })
    await tx.taskEvent.create({
      data: { taskId: task.id, eventType: 'comment_deleted', payload: { by, commentId: comment.id } },
    })
    const live = { taskCommentId: comment.id, organizationId: task.organizationId, removedAt: null }
    const files = await tx.attachment.findMany({ where: live, select: { id: true } })
    if (files.length === 0) return
    await tx.attachment.updateMany({
      where: { ...live, id: { in: files.map((file) => file.id) } },
      data: { removedAt: new Date(), ...attachmentRemover(actor), removedReason: COMMENT_REMOVAL_REASON },
    })
    await tx.taskEvent.createMany({
      data: files.map((file) => ({
        taskId: task.id,
        eventType: 'attachment_removed',
        payload: { by, attachmentId: file.id, reason: COMMENT_REMOVAL_REASON, commentId: comment.id },
      })),
    })
  })
  return { ok: true, projectId: task.projectId }
}
