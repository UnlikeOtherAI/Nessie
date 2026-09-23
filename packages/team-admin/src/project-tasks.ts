import type { Prisma, PrismaClient, TaskPriority, TaskStatus } from '@prisma/client'
import { claimTaskEmbeddingInTransaction } from '@nessie/db'
import {
  parseUserId,
  type AuthorizedActionContext,
  type TaskEmbedOrigin,
  type TaskEventOrigin,
} from '@nessie/schemas'
import { isAgentAccessibleToActor } from './access-checks.js'
import { projectTaskInclude, type ProjectTaskRecord } from './project-task-records.js'
import {
  isUuid,
  projectTaskVisibilityWhere,
  taskEventAuthorship,
  type ProjectTaskVisibility,
} from './task-access.js'
import { recordColumnEntered, resolveHomeColumnId } from './task-column-events.js'
import { recordTaskEvent } from './task-event-dispatch.js'
import {
  linkUploadsToTask,
  mapProjectTaskWithCount,
  mapProjectTasksWithCounts,
  recordAttachmentsAdded,
} from './task-attachments.js'
import { applyTaskLabelPlan, type TaskLabelSetError } from './task-labels.js'
import { isProjectTaskTransitionValid } from './project-task-status.js'
import { dropStalePlacements } from './project-task-move.js'
import {
  boardTaskPoolWhere,
  resolveProjectTaskDetailPlacement,
  resolveTaskHomeBoard,
} from './board-placement.js'
import {
  resolveOutboundAssignee,
  type BoardSourceWriteBack,
  type BoardSourceWriteBackError,
} from './board-source-writeback.js'
import { externalTenantKeyFor } from './board-source-identity.js'

export { updateProjectTask, type ProjectTaskUpdateFields } from './project-task-update.js'

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
  /** Semantic projection claimed while the originating session still exists. */
  embedding?: { model: string; origin?: TaskEmbedOrigin }
  /** Set when an agent creates the ticket; see `TaskActor`. */
  agentId?: string | null
  unattended?: boolean
  /** The authenticated door, stamped by the caller's auth layer; absent ⇒ `system`. */
  origin?: TaskEventOrigin
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
  const authorship = taskEventAuthorship({ ...input, userId: input.createdByUserId })
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
    // Where the new ticket landed: creating one straight into a start-work
    // column is a pickup under the same origin rule as moving it there.
    const placement = await resolveProjectTaskDetailPlacement(tx, created)
    const event = await recordTaskEvent(tx, {
      taskId: created.id,
      eventType: 'created',
      payload: {
        ...authorship,
        assigneeUserId: input.assigneeUserId ?? null,
        boardId: placement?.boardId ?? null,
        columnId: placement?.columnId ?? null,
      },
      scope: { organizationId: input.organizationId, projectId: input.projectId ?? null },
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
      }, { ...authorship, ownedWrittenUpstream: false })
    }
    const linked = await linkUploadsToTask(tx, {
      organizationId: input.organizationId, uploaderUserId: input.createdByUserId,
      taskId: created.id, attachmentIds: input.attachmentIds ?? [],
    })
    await recordAttachmentsAdded(tx, { taskId: created.id, by: input.createdByUserId, attachmentIds: linked })
    const result = linked.length > 0 || labelIds.length > 0
      ? await tx.task.findFirstOrThrow({ where: { id: created.id }, include: projectTaskInclude })
      : created
    if (input.embedding) {
      await claimTaskEmbeddingInTransaction(tx, {
        detail: created.detail,
        embeddingModel: input.embedding.model,
        id: created.id,
        organizationId: input.organizationId,
        ...(input.embedding.origin ? { origin: input.embedding.origin } : {}),
        purpose: created.purpose,
        title: created.title,
      })
    }
    return result
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
    /** Set when an agent assigns; see `TaskActor`. */
    agentId?: string | null
    unattended?: boolean
    /** The authenticated door, stamped by the caller's auth layer; absent ⇒ `system`. */
    origin?: TaskEventOrigin
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
    const event = await recordTaskEvent(tx, {
      taskId: input.taskId,
      eventType: assigned ? 'assigned' : 'unassigned',
      payload: {
        ...taskEventAuthorship({ ...input, userId: input.actorContext.actor.actorId }),
        assigneeUserId: userId,
        assigneeAgentId: agentId,
      },
      scope: { organizationId: input.organizationId, projectId: existing.projectId },
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
  input: {
    taskId: string
    organizationId: string
    status: TaskStatus
    /** Null for an agent with no person behind it; see `moveProjectTaskToColumn`. */
    actorId: string | null
    /** Set when an agent changes the status; see `TaskActor`. */
    agentId?: string | null
    unattended?: boolean
    /** The authenticated door, stamped by the caller's auth layer; absent ⇒ `system`. */
    origin?: TaskEventOrigin
  },
): Promise<ProjectTaskRecord | ProjectTaskTransitionError> => {
  const existing = await prisma.task.findFirst({
    where: { id: input.taskId, organizationId: input.organizationId },
    select: { id: true, status: true, projectId: true, boardId: true, archivedAt: true },
  })
  if (!existing) return { error: 'NOT_FOUND' }
  if (!isProjectTaskTransitionValid(existing.status, input.status)) return { error: 'INVALID_TRANSITION', from: existing.status }
  const authorship = taskEventAuthorship({ ...input, userId: input.actorId })
  const scope = { organizationId: input.organizationId, projectId: existing.projectId }
  const task = await prisma.$transaction(async (tx) => {
    const fromColumnId = await resolveHomeColumnId(tx, existing)
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
    await recordTaskEvent(tx, {
      taskId: input.taskId,
      eventType: 'status_changed',
      payload: { ...authorship, from: existing.status, to: input.status },
      scope,
    })
    // A new status is a new column on the ticket's board — the move a person
    // sees, and the one a ticket trigger reacts to.
    await recordColumnEntered(tx, {
      taskId: input.taskId,
      scope,
      fromColumnId,
      toColumnId: await resolveHomeColumnId(tx, { ...existing, status: input.status }),
      authorship,
    })
    return tx.task.findFirst({ where: { id: input.taskId }, include: projectTaskInclude })
  })
  return task ? mapProjectTaskWithCount(prisma, task) : { error: 'INVALID_TRANSITION', from: existing.status }
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
