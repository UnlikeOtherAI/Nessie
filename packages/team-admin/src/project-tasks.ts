import type { Prisma, PrismaClient, TaskPriority, TaskStatus } from '@prisma/client'
import { parseUserId, type AuthorizedActionContext } from '@nessie/schemas'
import { isAgentAccessibleToActor } from './access-checks.js'
import { projectTaskInclude, type ProjectTaskRecord } from './project-task-records.js'
import { isUuid, projectTaskVisibilityWhere, type ProjectTaskVisibility } from './task-access.js'
import {
  linkUploadsToTask,
  mapProjectTaskWithCount,
  mapProjectTasksWithCounts,
  recordAttachmentsAdded,
} from './task-attachments.js'
import { applyTaskLabelPlan, planTaskLabels, type TaskLabelSetError } from './task-labels.js'
import { isProjectTaskTransitionValid } from './project-task-status.js'
import { dropStalePlacements } from './project-task-move.js'
import { boardTaskPoolWhere, resolveTaskHomeBoard } from './board-placement.js'
import {
  resolveOutboundAssignee,
  type BoardSourceWriteBack,
  type BoardSourceWriteBackError,
} from './board-source-writeback.js'
import { externalTenantKeyFor } from './board-source-identity.js'
import {
  applyFieldValuesPatch,
  listTaskFieldDefinitions,
  validateFieldValuesPatch,
  type TaskFieldError,
} from './task-fields.js'

export type AssignableProjectTaskUser = { id: string; displayName: string }

export {
  projectTaskVisibilityWhere,
  type ProjectTaskVisibility,
} from './task-access.js'

const isOrganizationMember = async (
  prisma: PrismaClient,
  organizationId: string,
  userId: string,
): Promise<boolean> => Boolean(await prisma.organizationMember.findUnique({
  where: { organizationId_userId: { organizationId, userId }, deactivatedAt: null },
  select: { id: true },
}))

const isOrganizationProject = async (
  prisma: PrismaClient,
  organizationId: string,
  projectId: string,
): Promise<boolean> => Boolean(await prisma.project.findFirst({
  where: { id: projectId, organizationId },
  select: { id: true },
}))

export const listAssignableProjectTaskUsers = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<AssignableProjectTaskUser[]> => {
  const members = await prisma.organizationMember.findMany({
    where: { organizationId, deactivatedAt: null },
    select: { user: { select: { id: true, displayName: true } } },
    orderBy: { user: { displayName: 'asc' } },
  })
  return members.map((member) => ({ id: parseUserId(member.user.id), displayName: member.user.displayName }))
}

export const listProjectTasks = async (
  prisma: PrismaClient,
  organizationId: string,
  filters: { assigneeUserId?: string; ownerUserId?: string; status?: TaskStatus; projectId?: string },
  visibility?: ProjectTaskVisibility,
): Promise<ProjectTaskRecord[]> => {
  const tasks = await prisma.task.findMany({
    where: {
      organizationId,
      ...(filters.assigneeUserId ? { assigneeUserId: filters.assigneeUserId } : {}),
      ...(filters.ownerUserId ? { ownerUserId: filters.ownerUserId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...projectTaskVisibilityWhere(visibility),
    },
    include: projectTaskInclude,
    orderBy: { updatedAt: 'desc' },
    take: 200,
  })
  return mapProjectTasksWithCounts(prisma, tasks)
}

export const getProjectTask = async (
  prisma: PrismaClient,
  taskId: string,
  organizationId: string,
  visibility?: ProjectTaskVisibility,
): Promise<ProjectTaskRecord | null> => {
  const task = await prisma.task.findFirst({
    where: { id: taskId, organizationId, ...projectTaskVisibilityWhere(visibility) },
    include: projectTaskInclude,
  })
  return task ? mapProjectTaskWithCount(prisma, task) : null
}

export type ProjectTaskAssignmentAttention = (
  tx: Prisma.TransactionClient,
  input: {
    actorUserId: string
    assigneeUserId: string | null
    eventKey: string
    organizationId: string
    projectId: string | null
    taskId: string
  },
) => Promise<void>

export type CreateProjectTaskInput = {
  actorContext: AuthorizedActionContext
  organizationId: string
  createdByUserId: string
  title: string
  purpose?: string
  detail?: string
  projectId?: string
  /** The board the task is created on; absent ⇒ the project's default board. */
  boardId?: string
  iterationId?: string
  storyPoints?: number
  priority?: TaskPriority
  dueDate?: Date | null
  assigneeUserId?: string
  assigneeAgentId?: string
  ownerUserId?: string
  assignmentAttention?: ProjectTaskAssignmentAttention
  /** The project's labels to put on the new ticket. */
  labelIds?: readonly string[]
  /** The creator's own unlinked uploads (description images) to link to it. */
  attachmentIds?: readonly string[]
}

export type ProjectTaskCreateError = {
  error: 'ASSIGNEE_NOT_MEMBER' | 'ASSIGNEE_AGENT_NOT_FOUND' | 'OWNER_NOT_MEMBER' | 'PROJECT_NOT_FOUND' | 'ITERATION_NOT_FOUND' | 'BOARD_NOT_FOUND'
} | TaskLabelSetError

export const createProjectTask = async (
  prisma: PrismaClient,
  input: CreateProjectTaskInput,
): Promise<ProjectTaskRecord | ProjectTaskCreateError> => {
  if (input.projectId && !(await isOrganizationProject(prisma, input.organizationId, input.projectId))) {
    return { error: 'PROJECT_NOT_FOUND' }
  }
  if (input.iterationId) {
    const iteration = await prisma.iteration.findFirst({
      where: { id: input.iterationId, projectId: input.projectId ?? undefined, organizationId: input.organizationId },
      select: { id: true },
    })
    if (!input.projectId || !iteration) return { error: 'ITERATION_NOT_FOUND' }
  }
  // A board id names the board the card lands on, and a board belongs to one
  // project — so a board from another project is a refusal, not a cross-project
  // create.
  if (input.boardId) {
    const board = await prisma.board.findFirst({
      where: { id: input.boardId, projectId: input.projectId ?? undefined },
      select: { id: true },
    })
    if (!input.projectId || !board) return { error: 'BOARD_NOT_FOUND' }
  }
  if (input.assigneeUserId && !(await isOrganizationMember(prisma, input.organizationId, input.assigneeUserId))) return { error: 'ASSIGNEE_NOT_MEMBER' }
  if (input.assigneeAgentId && !(await isAgentAccessibleToActor(prisma, input.actorContext, input.assigneeAgentId))) return { error: 'ASSIGNEE_AGENT_NOT_FOUND' }
  if (input.ownerUserId && !(await isOrganizationMember(prisma, input.organizationId, input.ownerUserId))) return { error: 'OWNER_NOT_MEMBER' }
  const labelIds = [...new Set(input.labelIds ?? [])]
  if (labelIds.length > 0) {
    // A new ticket is native, so every label is local; it only has to be a
    // label of the board the ticket lands on (`boardId`, else the default).
    const board = await resolveTaskHomeBoard(prisma, {
      projectId: input.projectId ?? null,
      boardId: input.boardId ?? null,
    })
    const labels = board
      ? await prisma.taskLabel.findMany({
          where: { id: { in: labelIds.filter(isUuid) }, boardId: board.id },
          select: { id: true },
        })
      : []
    const found = new Set(labels.map((label) => label.id))
    const missing = labelIds.find((id) => !found.has(id))
    if (missing) return { error: 'LABEL_NOT_ON_BOARD', labelId: missing }
  }
  const status: TaskStatus = input.assigneeUserId || input.assigneeAgentId ? 'assigned' : 'inbox'
  const task = await prisma.$transaction(async (tx) => {
    const created = await tx.task.create({
      data: {
        organizationId: input.organizationId, projectId: input.projectId ?? null,
        boardId: input.boardId ?? null,
        iterationId: input.iterationId ?? null, storyPoints: input.storyPoints ?? null,
        priority: input.priority ?? 'medium', dueDate: input.dueDate ?? null,
        createdByUserId: input.createdByUserId, title: input.title,
        purpose: input.purpose ?? null, detail: input.detail ?? null,
        assigneeUserId: input.assigneeUserId ?? null, assigneeAgentId: input.assigneeAgentId ?? null,
        ownerUserId: input.ownerUserId ?? null, status,
      },
      include: projectTaskInclude,
    })
    const event = await tx.taskEvent.create({
      data: { taskId: created.id, eventType: 'created', payload: { by: input.createdByUserId, assigneeUserId: input.assigneeUserId ?? null } },
      select: { id: true },
    })
    await input.assignmentAttention?.(tx, {
      actorUserId: input.createdByUserId, assigneeUserId: input.assigneeUserId ?? null,
      eventKey: `task-assigned:${event.id}`, organizationId: input.organizationId,
      projectId: input.projectId ?? null, taskId: created.id,
    })
    if (labelIds.length > 0) {
      await applyTaskLabelPlan(tx, {
        taskId: created.id, added: labelIds, removed: [], localAdd: labelIds, localRemove: [],
        ownedAdd: [], ownedRemove: [], upstreamLabelIds: null,
      }, { by: input.createdByUserId, ownedWrittenUpstream: false })
    }
    const linked = await linkUploadsToTask(tx, {
      organizationId: input.organizationId, uploaderUserId: input.createdByUserId,
      taskId: created.id, attachmentIds: input.attachmentIds ?? [],
    })
    await recordAttachmentsAdded(tx, { taskId: created.id, by: input.createdByUserId, attachmentIds: linked })
    return linked.length > 0 || labelIds.length > 0
      ? tx.task.findFirstOrThrow({ where: { id: created.id }, include: projectTaskInclude })
      : created
  })
  return mapProjectTaskWithCount(prisma, task)
}

export type ProjectTaskAssignError = { error: 'NOT_FOUND' | 'ASSIGNEE_NOT_MEMBER' | 'ASSIGNEE_AGENT_NOT_FOUND' }

export const assignProjectTask = async (
  prisma: PrismaClient,
  input: {
    taskId: string
    organizationId: string
    assigneeUserId?: string | null
    assigneeAgentId?: string | null
    actorContext: AuthorizedActionContext
    assignmentAttention?: ProjectTaskAssignmentAttention
  },
  writeBack?: BoardSourceWriteBack,
): Promise<ProjectTaskRecord | ProjectTaskAssignError | BoardSourceWriteBackError> => {
  const existing = await prisma.task.findFirst({
    where: { id: input.taskId, organizationId: input.organizationId },
    select: { id: true, status: true, assigneeAgentId: true, assigneeUserId: true, projectId: true },
  })
  if (!existing) return { error: 'NOT_FOUND' }
  const agentId = input.assigneeAgentId ?? null
  const userId = agentId ? null : input.assigneeUserId ?? null
  if (userId && !(await isOrganizationMember(prisma, input.organizationId, userId))) return { error: 'ASSIGNEE_NOT_MEMBER' }
  if (agentId && !(await isAgentAccessibleToActor(prisma, input.actorContext, agentId))) return { error: 'ASSIGNEE_AGENT_NOT_FOUND' }
  if (existing.assigneeUserId === userId && existing.assigneeAgentId === agentId) {
    const task = await prisma.task.findFirst({ where: { id: existing.id }, include: projectTaskInclude })
    return task ? mapProjectTaskWithCount(prisma, task) : { error: 'NOT_FOUND' }
  }
  const assigned = Boolean(userId || agentId)

  // On a mirrored task the assignee is the source's, so it is written upstream
  // first — and an assignee nobody has linked to a provider account is refused
  // with the remedy rather than silently assigned only here.
  if (writeBack) {
    const link = await prisma.taskExternalLink.findUnique({
      where: { taskId: input.taskId },
      include: {
        source: {
          select: {
            provider: true,
            organizationId: true,
            container: true,
            connection: { select: { externalTenantId: true } },
          },
        },
      },
    })
    if (link) {
      const person = userId
        ? await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } })
        : null
      const external = await resolveOutboundAssignee(prisma, {
        organizationId: link.source.organizationId,
        provider: link.source.provider,
        externalTenantKey: externalTenantKeyFor(link.source),
        userId,
        agentId,
        displayName: person?.displayName ?? null,
      })
      if (external !== null && typeof external === 'object') return external
      const outcome = await writeBack.apply({
        taskId: input.taskId,
        change: { assigneeExternalUserId: external },
      })
      if (outcome && 'error' in outcome) return outcome
    }
  }

  const nextStatus = assigned && existing.status === 'inbox' ? 'assigned' : !assigned && existing.status === 'assigned' ? 'inbox' : undefined
  const task = await prisma.$transaction(async (tx) => {
    const { count } = await tx.task.updateMany({
      where: { id: input.taskId, organizationId: input.organizationId, status: existing.status },
      data: { assigneeUserId: userId, assigneeAgentId: agentId, ...(nextStatus ? { status: nextStatus } : {}) },
    })
    if (count === 0) return null
    const event = await tx.taskEvent.create({
      data: { taskId: input.taskId, eventType: assigned ? 'assigned' : 'unassigned', payload: { by: input.actorContext.actor.actorId, assigneeUserId: userId, assigneeAgentId: agentId } },
      select: { id: true },
    })
    await input.assignmentAttention?.(tx, {
      actorUserId: input.actorContext.actor.actorId, assigneeUserId: userId, eventKey: `task-assigned:${event.id}`,
      organizationId: input.organizationId, projectId: existing.projectId, taskId: existing.id,
    })
    return tx.task.findFirst({ where: { id: input.taskId }, include: projectTaskInclude })
  })
  return task ? mapProjectTaskWithCount(prisma, task) : { error: 'NOT_FOUND' }
}

export type ProjectTaskTransitionError = { error: 'NOT_FOUND' | 'INVALID_TRANSITION'; from?: TaskStatus }

export const transitionProjectTask = async (
  prisma: PrismaClient,
  input: { taskId: string; organizationId: string; status: TaskStatus; actorId: string },
): Promise<ProjectTaskRecord | ProjectTaskTransitionError> => {
  const existing = await prisma.task.findFirst({
    where: { id: input.taskId, organizationId: input.organizationId },
    select: { id: true, status: true },
  })
  if (!existing) return { error: 'NOT_FOUND' }
  if (!isProjectTaskTransitionValid(existing.status, input.status)) return { error: 'INVALID_TRANSITION', from: existing.status }
  const task = await prisma.$transaction(async (tx) => {
    const { count } = await tx.task.updateMany({
      where: { id: input.taskId, organizationId: input.organizationId, status: existing.status },
      data: { status: input.status },
    })
    if (count === 0) return null
    // A transition can move the task out of its pinned column's category —
    // into Archived, back out of it, or straight across. `resolveBoardPlacement`
    // ignores a stale pin, but leaving one behind would mean board-written data
    // that disagrees with the board, so it goes here on every board.
    await dropStalePlacements(tx, input.taskId)
    await tx.taskEvent.create({ data: { taskId: input.taskId, eventType: 'status_changed', payload: { by: input.actorId, from: existing.status, to: input.status } } })
    return tx.task.findFirst({ where: { id: input.taskId }, include: projectTaskInclude })
  })
  return task ? mapProjectTaskWithCount(prisma, task) : { error: 'INVALID_TRANSITION', from: existing.status }
}

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
    /** `TaskEvent.by` for the history rows this write adds, and the uploader whose files link. */
    actorId?: string
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
      projectId: true,
      boardId: true,
      detail: true,
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
    const by = input.actorId ?? null
    if (labelPlan) {
      await applyTaskLabelPlan(tx, labelPlan, { by, ownedWrittenUpstream: labelsWrittenUpstream })
    }
    // The description gets a history line at all; the text itself is not copied.
    if (input.fields.detail !== undefined && (input.fields.detail ?? null) !== existing.detail) {
      await tx.taskEvent.create({ data: { taskId: existing.id, eventType: 'detail_edited', payload: { by } } })
    }
    if (input.actorId && input.fields.attachmentIds?.length) {
      const linked = await linkUploadsToTask(tx, {
        organizationId: input.organizationId, uploaderUserId: input.actorId,
        taskId: existing.id, attachmentIds: input.fields.attachmentIds,
      })
      await recordAttachmentsAdded(tx, { taskId: existing.id, by: input.actorId, attachmentIds: linked })
    }
    return tx.task.findFirstOrThrow({ where: { id: existing.id }, include: projectTaskInclude })
  })
  return mapProjectTaskWithCount(prisma, task)
}

export const setProjectTaskIteration = async (
  prisma: PrismaClient,
  input: { taskId: string; organizationId: string; iterationId: string | null },
): Promise<ProjectTaskRecord | { error: 'NOT_FOUND' | 'ITERATION_NOT_FOUND' }> => {
  const existing = await prisma.task.findFirst({
    where: { id: input.taskId, organizationId: input.organizationId },
    select: { id: true, projectId: true },
  })
  if (!existing) return { error: 'NOT_FOUND' }
  if (input.iterationId) {
    const iteration = await prisma.iteration.findFirst({
      where: {
        id: input.iterationId,
        organizationId: input.organizationId,
        projectId: existing.projectId ?? undefined,
      },
      select: { id: true },
    })
    if (!existing.projectId || !iteration) return { error: 'ITERATION_NOT_FOUND' }
  }
  return mapProjectTaskWithCount(prisma, await prisma.task.update({
    where: { id: existing.id },
    data: { iterationId: input.iterationId },
    include: projectTaskInclude,
  }))
}

/**
 * Tuck completed work behind the Archived toggle. One explicit project, never
 * an organisation-wide implicit set.
 *
 * `boardId` narrows further, to one board's own tickets — the Archive control
 * lives on a board's Done column, and a board owns its tickets, so a click
 * there must not reach another board's completed work. Omitted, it archives
 * the whole project, which is what the personal assistant's
 * `ticket_archive_done` asks for by naming a project and no board.
 */
export const archiveProjectDoneTasks = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    projectId: string
    boardId?: string | null
    olderThanDays?: number | null
  },
): Promise<{ count: number } | { error: 'BOARD_NOT_FOUND' }> => {
  let pool: Prisma.TaskWhereInput = {}
  if (input.boardId) {
    const board = await prisma.board.findFirst({
      where: { id: input.boardId, projectId: input.projectId },
      select: { id: true, isDefault: true },
    })
    if (!board) return { error: 'BOARD_NOT_FOUND' }
    pool = boardTaskPoolWhere(board)
  }
  const now = new Date()
  const cutoff = input.olderThanDays && input.olderThanDays > 0
    ? new Date(now.getTime() - input.olderThanDays * 86_400_000)
    : null
  const { count } = await prisma.task.updateMany({
    where: { organizationId: input.organizationId, projectId: input.projectId, status: 'done', archivedAt: null, ...pool, ...(cutoff ? { updatedAt: { lt: cutoff } } : {}) },
    data: { archivedAt: now },
  })
  return { count }
}
