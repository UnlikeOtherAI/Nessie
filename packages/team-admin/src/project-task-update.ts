import type { Prisma, PrismaClient, TaskPriority } from '@prisma/client'
import { claimTaskEmbeddingInTransaction } from '@nessie/db'
import type { TaskEmbedOrigin, TaskEventOrigin } from '@nessie/schemas'

import { projectTaskInclude, type ProjectTaskRecord } from './project-task-records.js'
import { linkUploadsToTask, mapProjectTaskWithCount, recordAttachmentsAdded } from './task-attachments.js'
import { applyTaskLabelPlan, planTaskLabels, type TaskLabelSetError } from './task-labels.js'
import { SYSTEM_TASK_EVENT_ORIGIN, taskEventBy } from './task-access.js'
import { recordTaskEvent, taskDetailSha256 } from './task-event-dispatch.js'
import {
  type BoardSourceWriteBack,
  type BoardSourceWriteBackError,
} from './board-source-writeback.js'
import {
  applyFieldValuesPatch,
  listTaskFieldDefinitions,
  validateFieldValuesPatch,
  type TaskFieldError,
} from './task-fields.js'

export type ProjectTaskUpdateFields = {
  title?: string
  purpose?: string | null
  detail?: string | null
  priority?: TaskPriority
  dueDate?: Date | null
  archivedAt?: Date | null
  storyPoints?: number | null
  /** A partial merge of custom field values; `null` clears one. */
  fieldValues?: Record<string, unknown>
  /** Replace-set of the ticket's labels (`setTaskLabels` semantics). */
  labelIds?: readonly string[]
  /** The actor's own unlinked uploads (description images) to link to the ticket. */
  attachmentIds?: readonly string[]
}

export const updateProjectTask = async (
  prisma: PrismaClient,
  input: {
    taskId: string
    organizationId: string
    fields: ProjectTaskUpdateFields
    /**
     * `TaskEvent.by` for the history rows this write adds, and the uploader
     * whose files link. Absent or null for an agent with no person behind it,
     * which names itself with `agentId` and `unattended` and links no uploads.
     */
    actorId?: string | null
    /** Semantic projection claimed while the originating session still exists. */
    embedding?: { model: string; origin?: TaskEmbedOrigin }
    /** Set when an agent edits the ticket; see `TaskActor`. */
    agentId?: string | null
    unattended?: boolean
    /** The authenticated door, stamped by the caller's auth layer; absent ⇒ `system`. */
    origin?: TaskEventOrigin
  },
  writeBack?: BoardSourceWriteBack,
): Promise<
  | ProjectTaskRecord
  | { error: 'NOT_FOUND' }
  | TaskFieldError
  | TaskLabelSetError
  | BoardSourceWriteBackError
> => {
  const existing = await prisma.task.findFirst({
    where: { id: input.taskId, organizationId: input.organizationId },
    select: {
      id: true,
      organizationId: true,
      projectId: true,
      boardId: true,
      detail: true,
      priority: true,
      externalLink: { select: { sourceId: true } },
    },
  })
  if (!existing) return { error: 'NOT_FOUND' }
  const labelPlan = input.fields.labelIds === undefined
    ? null
    : await planTaskLabels(
        prisma,
        {
          id: existing.id,
          projectId: existing.projectId,
          boardId: existing.boardId ?? null,
          sourceId: existing.externalLink?.sourceId ?? null,
        },
        input.fields.labelIds,
      )
  if (labelPlan && 'error' in labelPlan) return labelPlan

  // Custom field values are validated against the project's own definitions
  // before anything is written, so the JSONB column cannot accumulate a key no
  // definition explains.
  const patch = input.fields.fieldValues
  if (patch && Object.keys(patch).length > 0) {
    if (!existing.projectId) return { error: 'FIELD_UNKNOWN', fieldId: Object.keys(patch)[0] ?? '' }
    const definitions = await listTaskFieldDefinitions(prisma, existing.projectId)
    // Only the values of `user` fields are candidate member ids. Every string
    // in the patch is not: a `select` value is an option id and a `text` value
    // is prose, and asking Postgres to cast either to a uuid is an error.
    const userFieldIds = new Set(
      definitions.filter((field) => field.type === 'user').map((field) => field.id),
    )
    const userIds = Object.entries(patch)
      .filter(([fieldId, value]) => userFieldIds.has(fieldId) && typeof value === 'string')
      .map(([, value]) => value as string)
    const activeMembers = new Set(
      (
        await prisma.organizationMember.findMany({
          // Liveness is on the membership, not the user: a deactivated member
          // keeps their row so an owner can reactivate them.
          where: {
            organizationId: input.organizationId,
            userId: { in: userIds },
            deactivatedAt: null,
          },
          select: { userId: true },
        })
      ).map((member) => member.userId),
    )
    const failure = validateFieldValuesPatch(definitions, patch, (userId) =>
      activeMembers.has(userId),
    )
    if (failure) return failure
  }

  // Title, detail and deadline are source-owned on a mirrored task: the vendor
  // is asked *after* everything local has been validated — so a rejected custom
  // field cannot leave an upstream write already made — and its echo, not this
  // request, becomes the mirror.
  const fields = { ...input.fields }
  let labelsWrittenUpstream = false
  if (writeBack) {
    const change = {
      ...(labelPlan?.upstreamLabelIds ? { labelIds: labelPlan.upstreamLabelIds } : {}),
      ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.detail !== undefined ? { description: fields.detail } : {}),
      ...(fields.dueDate !== undefined
        ? { dueDate: fields.dueDate?.toISOString().slice(0, 10) ?? null }
        : {}),
    }
    if (Object.keys(change).length > 0) {
      const outcome = await writeBack.apply({ taskId: input.taskId, change })
      if (outcome && 'error' in outcome) return outcome
      // The echo already wrote those columns; writing them again from the
      // request would overwrite whatever the provider actually stored.
      if (outcome) {
        labelsWrittenUpstream = Boolean(labelPlan?.upstreamLabelIds)
        delete fields.title
        delete fields.detail
        delete fields.dueDate
      }
    }
  }

  const data: Prisma.TaskUpdateInput = {}
  if (fields.title !== undefined) data.title = fields.title
  if (fields.purpose !== undefined) data.purpose = fields.purpose
  if (fields.detail !== undefined) data.detail = fields.detail
  if (fields.priority !== undefined) data.priority = fields.priority
  if (fields.dueDate !== undefined) data.dueDate = fields.dueDate
  if (fields.archivedAt !== undefined) data.archivedAt = fields.archivedAt
  if (fields.storyPoints !== undefined) data.storyPoints = fields.storyPoints

  const task = await prisma.$transaction(async (tx) => {
    if (Object.keys(data).length > 0) {
      await tx.task.update({ where: { id: existing.id }, data })
    }
    if (patch) await applyFieldValuesPatch(tx, existing.id, patch)
    const by = input.actorId || (input.unattended && input.agentId)
      ? taskEventBy({ ...input, userId: input.actorId ?? null })
      : null
    const origin = input.origin ?? SYSTEM_TASK_EVENT_ORIGIN
    const scope = { organizationId: existing.organizationId, projectId: existing.projectId }
    if (labelPlan) {
      await applyTaskLabelPlan(tx, labelPlan, { by, origin, ownedWrittenUpstream: labelsWrittenUpstream })
    }
    // The description gets a history line at all; the text itself is not
    // copied — only its hash, so a wake can tell whether what the ticket says
    // now is still what this author wrote (`detailSha256`).
    if (input.fields.detail !== undefined && (input.fields.detail ?? null) !== existing.detail) {
      await recordTaskEvent(tx, {
        taskId: existing.id,
        eventType: 'detail_edited',
        payload: { by, origin, detailSha256: taskDetailSha256(input.fields.detail ?? null) },
        scope,
      })
    }
    // A priority change wrote nothing before ticket triggers followed it.
    if (fields.priority !== undefined && fields.priority !== existing.priority) {
      await recordTaskEvent(tx, {
        taskId: existing.id,
        eventType: 'priority_changed',
        payload: { ...(by ? { by } : {}), origin, from: existing.priority, to: fields.priority },
        scope,
      })
    }
    if (input.actorId && input.fields.attachmentIds?.length) {
      const linked = await linkUploadsToTask(tx, {
        organizationId: input.organizationId,
        uploaderUserId: input.actorId,
        taskId: existing.id,
        attachmentIds: input.fields.attachmentIds,
      })
      await recordAttachmentsAdded(tx, {
        taskId: existing.id,
        by: input.actorId,
        attachmentIds: linked,
      })
    }
    const updated = await tx.task.findFirstOrThrow({
      where: { id: existing.id },
      include: projectTaskInclude,
    })
    if (input.embedding) {
      await claimTaskEmbeddingInTransaction(tx, {
        detail: updated.detail,
        embeddingModel: input.embedding.model,
        id: updated.id,
        organizationId: input.organizationId,
        ...(input.embedding.origin ? { origin: input.embedding.origin } : {}),
        purpose: updated.purpose,
        title: updated.title,
      })
    }
    return updated
  })
  return mapProjectTaskWithCount(prisma, task)
}
