import type { Prisma, PrismaClient } from '@prisma/client'
import {
  inlineAttachmentIds,
  inlineAttachmentPath,
  parseAgentId,
  parseTaskId,
  parseUserId,
  TASK_ATTACHMENT_REMOVE_REASON_MAX_CHARS,
  type TaskAttachmentRecord,
} from '@nessie/schemas'

import {
  countTaskAttachments,
  mapProjectTaskWithContext,
  type ProjectTaskRecord,
} from './project-task-records.js'
import { findAccessibleTask, isUuid, taskEventBy, type TaskActor } from './task-access.js'

/**
 * A ticket's files. Bytes arrive only through the one upload door
 * (`POST /api/uploads`) and are *linked* here. Removing a file from a ticket
 * marks the row (`removedAt` and who, and why) and never touches the bytes:
 * no path deletes a ticket file's bytes short of deleting the task.
 * `Attachment.taskId` is app-enforced, like `messageId`.
 */

type TaskRowForMap = Parameters<typeof mapProjectTaskWithContext>[0]

/** Map task rows with their real attachment counts — one grouped read for the page. */
export const mapProjectTasksWithCounts = async (
  prisma: { attachment: { groupBy: PrismaClient['attachment']['groupBy'] } },
  tasks: readonly TaskRowForMap[],
): Promise<ProjectTaskRecord[]> => {
  const counts = await countTaskAttachments(prisma, tasks.map((task) => task.id))
  return tasks.map((task) =>
    mapProjectTaskWithContext(task, { attachmentCount: counts.get(task.id) ?? 0 }))
}

export const mapProjectTaskWithCount = async (
  prisma: { attachment: { groupBy: PrismaClient['attachment']['groupBy'] } },
  task: TaskRowForMap,
): Promise<ProjectTaskRecord> => (await mapProjectTasksWithCounts(prisma, [task]))[0]!

export const taskAttachmentSelect = {
  id: true,
  taskId: true,
  taskCommentId: true,
  filename: true,
  mime: true,
  kind: true,
  sizeBytes: true,
  width: true,
  height: true,
  thumbnailKey: true,
  uploaderId: true,
  removedAt: true,
  removedByUserId: true,
  removedByAgentId: true,
  removedReason: true,
  createdAt: true,
} satisfies Prisma.AttachmentSelect

type AttachmentRow = Prisma.AttachmentGetPayload<{ select: typeof taskAttachmentSelect }>

type ExternalMark = NonNullable<TaskAttachmentRecord['external']>

export const mapTaskAttachment = (
  row: AttachmentRow,
  options: { inlineIds: ReadonlySet<string>; external?: ExternalMark | null },
): TaskAttachmentRecord => ({
  id: row.id,
  taskId: parseTaskId(row.taskId ?? ''),
  commentId: row.taskCommentId,
  filename: row.filename,
  mime: row.mime,
  kind: row.kind,
  sizeBytes: row.sizeBytes.toString(),
  width: row.width,
  height: row.height,
  hasThumbnail: row.thumbnailKey !== null,
  uploaderUserId: row.uploaderId ? parseUserId(row.uploaderId) : null,
  downloadPath: inlineAttachmentPath(row.id),
  thumbnailPath: row.thumbnailKey ? `${inlineAttachmentPath(row.id)}/thumbnail` : null,
  inline: options.inlineIds.has(row.id),
  external: options.external ?? null,
  removed: row.removedAt
    ? {
        at: row.removedAt.toISOString(),
        byUserId: row.removedByUserId ? parseUserId(row.removedByUserId) : null,
        byAgentId: row.removedByAgentId ? parseAgentId(row.removedByAgentId) : null,
        reason: row.removedReason,
      }
    : null,
  createdAt: row.createdAt.toISOString(),
})

/** Every attachment id referenced from the description or a live comment body. */
export const collectInlineAttachmentIds = async (
  prisma: PrismaClient,
  task: { id: string; detail: string | null },
): Promise<Set<string>> => {
  const comments = await prisma.taskComment.findMany({
    where: { taskId: task.id, deletedAt: null },
    select: { body: true },
  })
  return new Set([task.detail ?? '', ...comments.map((comment) => comment.body)].flatMap(inlineAttachmentIds))
}

/**
 * Point the actor's own still-unlinked uploads at a task (and a comment).
 * Ids the actor did not upload, or that are already linked anywhere, are
 * skipped — as the message composer's link does — and the ids that actually
 * linked are returned, because what was asked for is not authoritative. An
 * actor with no person behind it (`AgentTaskActor`) has no uploads of its own,
 * so it links nothing.
 */
export const linkUploadsToTask = async (
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    uploaderUserId: string | null
    taskId: string
    commentId?: string | null
    attachmentIds: readonly string[]
  },
): Promise<string[]> => {
  const ids = input.attachmentIds.filter(isUuid)
  if (ids.length === 0 || input.uploaderUserId === null) return []
  const eligible: Prisma.AttachmentWhereInput = {
    id: { in: ids },
    organizationId: input.organizationId,
    uploaderId: input.uploaderUserId,
    messageId: null,
    knowledgePageId: null,
    emailMessageId: null,
    taskId: null,
    taskCommentId: null,
    // An executor command's image is the run's, never a pending upload.
    executorCommandId: null,
  }
  const candidates = await tx.attachment.findMany({ where: eligible, select: { id: true } })
  if (candidates.length === 0) return []
  await tx.attachment.updateMany({
    where: { ...eligible, id: { in: candidates.map((row) => row.id) } },
    data: { taskId: input.taskId, taskCommentId: input.commentId ?? null },
  })
  const linked = await tx.attachment.findMany({
    where: {
      id: { in: candidates.map((row) => row.id) },
      taskId: input.taskId,
      taskCommentId: input.commentId ?? null,
    },
    select: { id: true },
  })
  return linked.map((row) => row.id)
}

/** Record an `attachment_added` event for ids that actually linked. */
export const recordAttachmentsAdded = async (
  tx: Prisma.TransactionClient,
  input: { taskId: string; by: string; attachmentIds: string[]; commentId?: string | null },
): Promise<void> => {
  if (input.attachmentIds.length === 0) return
  await tx.taskEvent.create({
    data: {
      taskId: input.taskId,
      eventType: 'attachment_added',
      payload: {
        by: input.by,
        attachmentIds: input.attachmentIds,
        ...(input.commentId ? { commentId: input.commentId } : {}),
      },
    },
  })
}

/**
 * The Attachments list: stored files (`Attachment.taskId`, comment files
 * included, removed ones too — marked, in their place) and the external
 * assets that have no stored copy (`link`, or a fetch that gave up), newest
 * first. A stored copy of a provider file is one row, marked with its
 * external origin.
 */
export const listTaskAttachments = async (
  prisma: PrismaClient,
  actor: TaskActor,
  input: { taskId: string },
): Promise<{ attachments: TaskAttachmentRecord[] } | { error: 'NOT_FOUND' }> => {
  const task = await findAccessibleTask(prisma, actor, input.taskId)
  if (!task) return { error: 'NOT_FOUND' }
  const [stored, assets, inlineIds] = await Promise.all([
    prisma.attachment.findMany({
      where: { taskId: task.id, organizationId: task.organizationId },
      select: taskAttachmentSelect,
    }),
    prisma.taskExternalAsset.findMany({
      where: { taskId: task.id },
      select: {
        id: true,
        taskCommentId: true,
        sourceId: true,
        externalUrl: true,
        title: true,
        status: true,
        attachmentId: true,
        createdAt: true,
        source: { select: { provider: true } },
      },
    }),
    collectInlineAttachmentIds(prisma, task),
  ])
  const storedOrigin = new Map(
    assets.flatMap((asset) => (asset.status === 'stored' && asset.attachmentId
      ? [[asset.attachmentId, asset] as const]
      : [])),
  )
  const records: TaskAttachmentRecord[] = stored.map((row) => {
    const origin = storedOrigin.get(row.id)
    return mapTaskAttachment(row, {
      inlineIds,
      external: origin
        ? {
            sourceId: origin.sourceId,
            provider: origin.source.provider,
            externalUrl: origin.externalUrl,
            title: origin.title,
            status: 'stored',
          }
        : null,
    })
  })
  for (const asset of assets) {
    if (asset.status !== 'link' && asset.status !== 'failed') continue
    records.push({
      id: asset.id,
      taskId: parseTaskId(task.id),
      commentId: asset.taskCommentId,
      filename: asset.title ?? asset.externalUrl,
      mime: '',
      kind: 'link',
      sizeBytes: '0',
      width: null,
      height: null,
      hasThumbnail: false,
      uploaderUserId: null,
      downloadPath: asset.externalUrl,
      thumbnailPath: null,
      inline: false,
      external: {
        sourceId: asset.sourceId,
        provider: asset.source.provider,
        externalUrl: asset.externalUrl,
        title: asset.title,
        status: asset.status,
      },
      removed: null,
      createdAt: asset.createdAt.toISOString(),
    })
  }
  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  return { attachments: records }
}

/**
 * Link uploads to a ticket (the Attachments section's upload, the editor's
 * image insert in edit mode). Returns the rows that linked; skipped ids are
 * simply absent.
 */
export const linkTaskAttachments = async (
  prisma: PrismaClient,
  actor: TaskActor,
  input: { taskId: string; attachmentIds: readonly string[] },
): Promise<
  { attachments: TaskAttachmentRecord[]; projectId: string | null } | { error: 'NOT_FOUND' }
> => {
  const task = await findAccessibleTask(prisma, actor, input.taskId)
  if (!task) return { error: 'NOT_FOUND' }
  const linked = await prisma.$transaction(async (tx) => {
    const ids = await linkUploadsToTask(tx, {
      organizationId: task.organizationId,
      uploaderUserId: actor.userId,
      taskId: task.id,
      attachmentIds: input.attachmentIds,
    })
    await recordAttachmentsAdded(tx, { taskId: task.id, by: taskEventBy(actor), attachmentIds: ids })
    return ids
  })
  if (linked.length === 0) return { attachments: [], projectId: task.projectId }
  const [rows, inlineIds] = await Promise.all([
    prisma.attachment.findMany({ where: { id: { in: linked } }, select: taskAttachmentSelect }),
    collectInlineAttachmentIds(prisma, task),
  ])
  return {
    attachments: rows.map((row) => mapTaskAttachment(row, { inlineIds })),
    projectId: task.projectId,
  }
}

/** A reason as stored: trimmed, capped, and null when nothing is left. */
export const normalizeRemovalReason = (reason: string | null | undefined): string | null => {
  const trimmed = reason?.trim().slice(0, TASK_ATTACHMENT_REMOVE_REASON_MAX_CHARS).trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/**
 * Who removed a file, as the row stores it: the actor's person (a personal
 * assistant acts as its person), or — for an unattended agent run — the agent
 * alone. An agent acting for a requester records both.
 */
export const attachmentRemover = (actor: TaskActor) => ({
  removedByUserId: actor.unattended ? null : actor.userId,
  removedByAgentId: actor.agentId ?? null,
})

/**
 * Remove a file from a ticket: anyone who can see the ticket may. Removal
 * marks the row — who, when, why — and the bytes stay, still downloadable
 * through the `taskId` ACL arm; there is no restore door in v1, but the row
 * keeps everything one would need. A provider-stored copy is the provider's
 * file and is not removable here; a second removal never overwrites the
 * first remover or reason.
 */
export const removeTaskAttachment = async (
  prisma: PrismaClient,
  actor: TaskActor,
  input: { taskId: string; attachmentId: string; reason?: string | null },
): Promise<
  | { ok: true; projectId: string | null; attachment: TaskAttachmentRecord }
  | {
      error:
        | 'NOT_FOUND'
        | 'ATTACHMENT_NOT_ON_TASK'
        | 'ATTACHMENT_NOT_REMOVABLE'
        | 'ATTACHMENT_ALREADY_REMOVED'
    }
> => {
  const task = await findAccessibleTask(prisma, actor, input.taskId)
  if (!task) return { error: 'NOT_FOUND' }
  if (!isUuid(input.attachmentId)) return { error: 'ATTACHMENT_NOT_ON_TASK' }
  const attachment = await prisma.attachment.findFirst({
    where: { id: input.attachmentId, taskId: task.id, organizationId: task.organizationId },
    select: { id: true, taskCommentId: true, removedAt: true },
  })
  if (!attachment) return { error: 'ATTACHMENT_NOT_ON_TASK' }
  if (attachment.removedAt) return { error: 'ATTACHMENT_ALREADY_REMOVED' }
  const providerCopy = await prisma.taskExternalAsset.count({
    where: { taskId: task.id, attachmentId: attachment.id, status: 'stored' },
  })
  if (providerCopy > 0) return { error: 'ATTACHMENT_NOT_REMOVABLE' }
  const reason = normalizeRemovalReason(input.reason)
  const removed = await prisma.$transaction(async (tx) => {
    const { count } = await tx.attachment.updateMany({
      where: { id: attachment.id, taskId: task.id, removedAt: null },
      data: { removedAt: new Date(), ...attachmentRemover(actor), removedReason: reason },
    })
    // Somebody else got there between the read and the write: theirs stands.
    if (count === 0) return false
    await tx.taskEvent.create({
      data: {
        taskId: task.id,
        eventType: 'attachment_removed',
        payload: {
          by: taskEventBy(actor),
          attachmentId: attachment.id,
          reason,
          ...(attachment.taskCommentId ? { commentId: attachment.taskCommentId } : {}),
        },
      },
    })
    return true
  })
  if (!removed) return { error: 'ATTACHMENT_ALREADY_REMOVED' }
  // Not a provider copy (refused above), so the row has no external origin.
  const [row, inlineIds] = await Promise.all([
    prisma.attachment.findUniqueOrThrow({ where: { id: attachment.id }, select: taskAttachmentSelect }),
    collectInlineAttachmentIds(prisma, task),
  ])
  return {
    ok: true,
    projectId: task.projectId,
    attachment: mapTaskAttachment(row, { inlineIds }),
  }
}
