import type { Prisma, PrismaClient, TaskPriority, TaskStatus } from '@prisma/client'
import { parseUserId } from '@nessie/schemas'
import type { AssignableUser, TaskRecord } from '../contracts.js'
import { mapTask, taskInclude } from './task-records.js'
import { isValidTransition } from './task-status.js'

export { moveTaskToColumn } from './task-board-move.js'
export { isValidTransition } from './task-status.js'

const isOrgMember = async (
  prisma: PrismaClient,
  organizationId: string,
  userId: string,
): Promise<boolean> => {
  const membership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { id: true },
  })
  return Boolean(membership)
}

const isOrgProject = async (
  prisma: PrismaClient,
  organizationId: string,
  projectId: string,
): Promise<boolean> => {
  const project = await prisma.project.findFirst({
    where: { id: projectId, organizationId },
    select: { id: true },
  })
  return Boolean(project)
}

const isOrgAgent = async (
  prisma: PrismaClient,
  organizationId: string,
  agentId: string,
): Promise<boolean> => {
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, organizationId },
    select: { id: true },
  })
  return Boolean(agent)
}

export const listAssignableUsers = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<AssignableUser[]> => {
  // Only id + displayName: an assignee picker does not need each member's role,
  // and exposing it to every member leaks who holds owner/admin (the owner-gated
  // /api/users endpoint is the place that returns roles).
  const members = await prisma.organizationMember.findMany({
    where: { organizationId },
    select: { user: { select: { id: true, displayName: true } } },
    orderBy: { user: { displayName: 'asc' } },
  })
  return members.map((member) => ({
    id: parseUserId(member.user.id),
    displayName: member.user.displayName,
  }))
}

/**
 * Membership visibility for a non-owner caller: the projects they belong to,
 * plus tasks that have no project, plus tasks they own or are assigned. Owners
 * pass `undefined` and keep full org visibility.
 */
export type TaskVisibility = {
  accessibleProjectIds: string[]
  actorUserId: string
}

export const taskVisibilityWhere = (visibility?: TaskVisibility) =>
  visibility
    ? {
        OR: [
          { projectId: { in: visibility.accessibleProjectIds } },
          { projectId: null },
          { ownerUserId: visibility.actorUserId },
          { assigneeUserId: visibility.actorUserId },
        ],
      }
    : {}

export const listTasks = async (
  prisma: PrismaClient,
  organizationId: string,
  filters: {
    assigneeUserId?: string
    ownerUserId?: string
    status?: TaskStatus
    projectId?: string
  },
  visibility?: TaskVisibility,
): Promise<TaskRecord[]> => {
  const tasks = await prisma.task.findMany({
    where: {
      organizationId,
      ...(filters.assigneeUserId ? { assigneeUserId: filters.assigneeUserId } : {}),
      ...(filters.ownerUserId ? { ownerUserId: filters.ownerUserId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...taskVisibilityWhere(visibility),
    },
    include: taskInclude,
    // Manual per-column order first (position asc), newest first within a tie so
    // freshly created cards surface at the top until they are reordered.
    orderBy: [{ position: 'asc' }, { updatedAt: 'desc' }],
    take: 200,
  })
  return tasks.map(mapTask)
}

export const getTask = async (
  prisma: PrismaClient,
  taskId: string,
  organizationId: string,
  visibility?: TaskVisibility,
): Promise<TaskRecord | null> => {
  const task = await prisma.task.findFirst({
    where: { id: taskId, organizationId, ...taskVisibilityWhere(visibility) },
    include: taskInclude,
  })
  return task ? mapTask(task) : null
}

type CreateTaskInput = {
  organizationId: string
  createdByUserId: string
  title: string
  purpose?: string
  detail?: string
  projectId?: string
  iterationId?: string
  storyPoints?: number
  priority?: TaskPriority
  dueDate?: Date | null
  assigneeUserId?: string
  assigneeAgentId?: string
  ownerUserId?: string
}

type TaskError = {
  error:
    | 'ASSIGNEE_NOT_MEMBER'
    | 'ASSIGNEE_AGENT_NOT_FOUND'
    | 'OWNER_NOT_MEMBER'
    | 'PROJECT_NOT_FOUND'
    | 'ITERATION_NOT_FOUND'
}

export const createHumanTask = async (
  prisma: PrismaClient,
  input: CreateTaskInput,
): Promise<TaskRecord | TaskError> => {
  if (input.projectId && !(await isOrgProject(prisma, input.organizationId, input.projectId))) {
    return { error: 'PROJECT_NOT_FOUND' }
  }
  if (input.iterationId) {
    const iteration = await prisma.iteration.findFirst({
      where: { id: input.iterationId, projectId: input.projectId ?? undefined, organizationId: input.organizationId },
      select: { id: true },
    })
    if (!input.projectId || !iteration) return { error: 'ITERATION_NOT_FOUND' }
  }
  if (input.assigneeUserId && !(await isOrgMember(prisma, input.organizationId, input.assigneeUserId))) {
    return { error: 'ASSIGNEE_NOT_MEMBER' }
  }
  if (input.assigneeAgentId && !(await isOrgAgent(prisma, input.organizationId, input.assigneeAgentId))) {
    return { error: 'ASSIGNEE_AGENT_NOT_FOUND' }
  }
  if (input.ownerUserId && !(await isOrgMember(prisma, input.organizationId, input.ownerUserId))) {
    return { error: 'OWNER_NOT_MEMBER' }
  }

  const status: TaskStatus = input.assigneeUserId || input.assigneeAgentId ? 'assigned' : 'inbox'
  const task = await prisma.task.create({
    data: {
      organizationId: input.organizationId,
      projectId: input.projectId ?? null,
      iterationId: input.iterationId ?? null,
      storyPoints: input.storyPoints ?? null,
      priority: input.priority ?? 'medium',
      dueDate: input.dueDate ?? null,
      createdByUserId: input.createdByUserId,
      title: input.title,
      purpose: input.purpose ?? null,
      detail: input.detail ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      ownerUserId: input.ownerUserId ?? null,
      status,
    },
    include: taskInclude,
  })

  await prisma.taskEvent.create({
    data: {
      taskId: task.id,
      eventType: 'created',
      payload: { by: input.createdByUserId, assigneeUserId: input.assigneeUserId ?? null },
    },
  })

  return mapTask(task)
}

type AssignError = { error: 'NOT_FOUND' | 'ASSIGNEE_NOT_MEMBER' | 'ASSIGNEE_AGENT_NOT_FOUND' }

export const assignTask = async (
  prisma: PrismaClient,
  input: {
    taskId: string
    organizationId: string
    assigneeUserId?: string | null
    assigneeAgentId?: string | null
    actorId: string
  },
): Promise<TaskRecord | AssignError> => {
  const existing = await prisma.task.findFirst({
    where: { id: input.taskId, organizationId: input.organizationId },
    select: { id: true, status: true },
  })
  if (!existing) return { error: 'NOT_FOUND' }

  // Assignment targets a person or an agent, never both: an agent target wins
  // when supplied, otherwise the user target. assigneeAgentId is deliberately a
  // distinct column from the worker's agentId so this never enqueues agent work.
  const agentId = input.assigneeAgentId ?? null
  const userId = agentId ? null : input.assigneeUserId ?? null

  if (userId && !(await isOrgMember(prisma, input.organizationId, userId))) {
    return { error: 'ASSIGNEE_NOT_MEMBER' }
  }
  if (agentId && !(await isOrgAgent(prisma, input.organizationId, agentId))) {
    return { error: 'ASSIGNEE_AGENT_NOT_FOUND' }
  }

  const assigned = Boolean(userId || agentId)
  // Reflect assignment in status when sitting in the default lanes.
  let nextStatus: TaskStatus | undefined
  if (assigned && existing.status === 'inbox') nextStatus = 'assigned'
  if (!assigned && existing.status === 'assigned') nextStatus = 'inbox'

  // Atomic, org-scoped, optimistic-locked write: the status guard makes the read
  // above authoritative even under concurrent assigns, and organizationId keeps
  // the mutation tenant-scoped at the write layer (not just the read).
  const task = await prisma.$transaction(async (tx) => {
    const { count } = await tx.task.updateMany({
      where: {
        id: input.taskId,
        organizationId: input.organizationId,
        status: existing.status,
      },
      data: {
        assigneeUserId: userId,
        assigneeAgentId: agentId,
        ...(nextStatus ? { status: nextStatus } : {}),
      },
    })
    if (count === 0) return null
    await tx.taskEvent.create({
      data: {
        taskId: input.taskId,
        eventType: assigned ? 'assigned' : 'unassigned',
        payload: { by: input.actorId, assigneeUserId: userId, assigneeAgentId: agentId },
      },
    })
    return tx.task.findFirst({ where: { id: input.taskId }, include: taskInclude })
  })

  if (!task) return { error: 'NOT_FOUND' }
  return mapTask(task)
}

type TransitionError = { error: 'NOT_FOUND' | 'INVALID_TRANSITION'; from?: TaskStatus }

export const transitionTask = async (
  prisma: PrismaClient,
  input: {
    taskId: string
    organizationId: string
    status: TaskStatus
    actorId: string
  },
): Promise<TaskRecord | TransitionError> => {
  const existing = await prisma.task.findFirst({
    where: { id: input.taskId, organizationId: input.organizationId },
    select: { id: true, status: true },
  })
  if (!existing) return { error: 'NOT_FOUND' }

  if (!isValidTransition(existing.status, input.status)) {
    return { error: 'INVALID_TRANSITION', from: existing.status }
  }

  // Atomic, org-scoped, optimistic-locked transition: guarding the write on the
  // status we validated makes isValidTransition authoritative — a concurrent
  // change (count === 0) is reported as an invalid transition rather than silently
  // applying against stale state.
  const task = await prisma.$transaction(async (tx) => {
    const { count } = await tx.task.updateMany({
      where: {
        id: input.taskId,
        organizationId: input.organizationId,
        status: existing.status,
      },
      data: { status: input.status },
    })
    if (count === 0) return null
    await tx.taskEvent.create({
      data: {
        taskId: input.taskId,
        eventType: 'status_changed',
        payload: { by: input.actorId, from: existing.status, to: input.status },
      },
    })
    return tx.task.findFirst({ where: { id: input.taskId }, include: taskInclude })
  })

  if (!task) return { error: 'INVALID_TRANSITION', from: existing.status }
  return mapTask(task)
}

type TaskMutationError = { error: 'NOT_FOUND' | 'ITERATION_NOT_FOUND' }

export const setTaskIteration = async (
  prisma: PrismaClient,
  input: { taskId: string; organizationId: string; iterationId: string | null },
): Promise<TaskRecord | TaskMutationError> => {
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

  const task = await prisma.task.update({
    where: { id: existing.id },
    data: { iterationId: input.iterationId },
    include: taskInclude,
  })
  return mapTask(task)
}

export type TaskUpdateFields = {
  title?: string
  purpose?: string | null
  detail?: string | null
  priority?: TaskPriority
  dueDate?: Date | null
  archivedAt?: Date | null
  storyPoints?: number | null
}

// Partial update of the human-editable task fields. Only keys present in
// `fields` are written; assignment and status live behind their own endpoints
// because they carry lifecycle side effects.
export const updateTask = async (
  prisma: PrismaClient,
  input: { taskId: string; organizationId: string; fields: TaskUpdateFields },
): Promise<TaskRecord | { error: 'NOT_FOUND' }> => {
  const existing = await prisma.task.findFirst({
    where: { id: input.taskId, organizationId: input.organizationId },
    select: { id: true },
  })
  if (!existing) return { error: 'NOT_FOUND' }

  const data: Prisma.TaskUpdateInput = {}
  if (input.fields.title !== undefined) data.title = input.fields.title
  if (input.fields.purpose !== undefined) data.purpose = input.fields.purpose
  if (input.fields.detail !== undefined) data.detail = input.fields.detail
  if (input.fields.priority !== undefined) data.priority = input.fields.priority
  if (input.fields.dueDate !== undefined) data.dueDate = input.fields.dueDate
  if (input.fields.archivedAt !== undefined) data.archivedAt = input.fields.archivedAt
  if (input.fields.storyPoints !== undefined) data.storyPoints = input.fields.storyPoints

  const task = await prisma.task.update({
    where: { id: existing.id },
    data,
    include: taskInclude,
  })
  return mapTask(task)
}

// Bulk-archive the org's done work. olderThanDays (when set) limits it to tasks
// last touched before the cutoff; otherwise every still-unarchived done task is
// stamped. Archiving only sets archivedAt — status stays `done` so it can be
// unarchived — and the board moves stamped cards into its Archived section.
export const archiveDoneTasks = async (
  prisma: PrismaClient,
  input: { organizationId: string; olderThanDays?: number | null },
): Promise<{ count: number }> => {
  const now = new Date()
  const cutoff =
    input.olderThanDays && input.olderThanDays > 0
      ? new Date(now.getTime() - input.olderThanDays * 24 * 60 * 60 * 1000)
      : null
  const { count } = await prisma.task.updateMany({
    where: {
      organizationId: input.organizationId,
      status: 'done',
      archivedAt: null,
      ...(cutoff ? { updatedAt: { lt: cutoff } } : {}),
    },
    data: { archivedAt: now },
  })
  return { count }
}
