import type { Prisma, PrismaClient, TaskPriority, TaskStatus } from '@prisma/client'
import {
  parseAgentId,
  parseOrganizationId,
  parseProjectId,
  parseTaskId,
  parseUserId,
} from '@nessie/schemas'
import type { AssignableUser, TaskRecord } from '../contracts.js'

// The four Kanban board columns map to the canonical statuses
// {inbox, in_progress, review, done}. Human users drag cards freely between
// those columns, so every column-to-column move must be a legal transition —
// including the backward ones a strict lifecycle would forbid. The extra edges
// below are purely additive; the agent-only paths (awaiting_approval, failed,
// cancelled) keep their original transitions.
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  inbox: ['assigned', 'in_progress', 'review', 'done', 'cancelled'],
  assigned: ['in_progress', 'review', 'done', 'inbox', 'cancelled'],
  in_progress: ['inbox', 'review', 'awaiting_approval', 'done', 'failed', 'cancelled'],
  review: ['inbox', 'in_progress', 'done', 'failed', 'cancelled'],
  awaiting_approval: ['inbox', 'in_progress', 'done', 'failed', 'cancelled'],
  done: ['inbox', 'in_progress', 'review'],
  failed: ['in_progress', 'cancelled'],
  cancelled: ['inbox'],
}

export const isValidTransition = (from: TaskStatus, to: TaskStatus): boolean =>
  from !== to && (VALID_TRANSITIONS[from]?.includes(to) ?? false)

const taskInclude = {
  assignee: { select: { displayName: true } },
  owner: { select: { displayName: true } },
} satisfies Prisma.TaskInclude

type TaskWithUsers = Prisma.TaskGetPayload<{ include: typeof taskInclude }>

const mapTask = (task: TaskWithUsers): TaskRecord => ({
  id: parseTaskId(task.id),
  organizationId: parseOrganizationId(task.organizationId),
  projectId: task.projectId ? parseProjectId(task.projectId) : null,
  columnId: task.columnId ?? null,
  iterationId: task.iterationId ?? null,
  storyPoints: task.storyPoints ?? null,
  agentId: task.agentId ? parseAgentId(task.agentId) : null,
  parentTaskId: task.parentTaskId ? parseTaskId(task.parentTaskId) : null,
  runId: task.runId ? (task.runId as TaskRecord['runId']) : null,
  status: task.status,
  priority: task.priority,
  dueDate: task.dueDate ? task.dueDate.toISOString() : null,
  title: task.title,
  purpose: task.purpose,
  detail: task.detail,
  assigneeUserId: task.assigneeUserId ? parseUserId(task.assigneeUserId) : null,
  assigneeName: task.assignee?.displayName ?? null,
  ownerUserId: task.ownerUserId ? parseUserId(task.ownerUserId) : null,
  ownerName: task.owner?.displayName ?? null,
  createdByUserId: task.createdByUserId ? parseUserId(task.createdByUserId) : null,
  createdAt: task.createdAt.toISOString(),
  updatedAt: task.updatedAt.toISOString(),
})

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

export const listTasks = async (
  prisma: PrismaClient,
  organizationId: string,
  filters: {
    assigneeUserId?: string
    ownerUserId?: string
    status?: TaskStatus
    projectId?: string
  },
): Promise<TaskRecord[]> => {
  const tasks = await prisma.task.findMany({
    where: {
      organizationId,
      ...(filters.assigneeUserId ? { assigneeUserId: filters.assigneeUserId } : {}),
      ...(filters.ownerUserId ? { ownerUserId: filters.ownerUserId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
    },
    include: taskInclude,
    orderBy: [{ updatedAt: 'desc' }],
    take: 200,
  })
  return tasks.map(mapTask)
}

export const getTask = async (
  prisma: PrismaClient,
  taskId: string,
  organizationId: string,
): Promise<TaskRecord | null> => {
  const task = await prisma.task.findFirst({
    where: { id: taskId, organizationId },
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
  ownerUserId?: string
}

type TaskError = {
  error: 'ASSIGNEE_NOT_MEMBER' | 'OWNER_NOT_MEMBER' | 'PROJECT_NOT_FOUND' | 'ITERATION_NOT_FOUND'
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
  if (input.ownerUserId && !(await isOrgMember(prisma, input.organizationId, input.ownerUserId))) {
    return { error: 'OWNER_NOT_MEMBER' }
  }

  const status: TaskStatus = input.assigneeUserId ? 'assigned' : 'inbox'
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

type AssignError = { error: 'NOT_FOUND' | 'ASSIGNEE_NOT_MEMBER' }

export const assignTask = async (
  prisma: PrismaClient,
  input: {
    taskId: string
    organizationId: string
    assigneeUserId: string | null
    actorId: string
  },
): Promise<TaskRecord | AssignError> => {
  const existing = await prisma.task.findFirst({
    where: { id: input.taskId, organizationId: input.organizationId },
    select: { id: true, status: true },
  })
  if (!existing) return { error: 'NOT_FOUND' }

  if (
    input.assigneeUserId &&
    !(await isOrgMember(prisma, input.organizationId, input.assigneeUserId))
  ) {
    return { error: 'ASSIGNEE_NOT_MEMBER' }
  }

  // Reflect assignment in status when sitting in the default lanes.
  let nextStatus: TaskStatus | undefined
  if (input.assigneeUserId && existing.status === 'inbox') nextStatus = 'assigned'
  if (!input.assigneeUserId && existing.status === 'assigned') nextStatus = 'inbox'

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
        assigneeUserId: input.assigneeUserId,
        ...(nextStatus ? { status: nextStatus } : {}),
      },
    })
    if (count === 0) return null
    await tx.taskEvent.create({
      data: {
        taskId: input.taskId,
        eventType: input.assigneeUserId ? 'assigned' : 'unassigned',
        payload: { by: input.actorId, assigneeUserId: input.assigneeUserId },
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
  if (input.fields.storyPoints !== undefined) data.storyPoints = input.fields.storyPoints

  const task = await prisma.task.update({
    where: { id: existing.id },
    data,
    include: taskInclude,
  })
  return mapTask(task)
}

// Each board column maps onto one canonical lifecycle status. Dragging a card
// to a column pins it (columnId) and, when the column's category differs from
// the card's current status, applies the matching validated transition — so
// Task.status stays the single source of truth the worker/approvals rely on.
const CATEGORY_TO_STATUS: Record<'todo' | 'in_progress' | 'review' | 'done', TaskStatus> = {
  todo: 'inbox',
  in_progress: 'in_progress',
  review: 'review',
  done: 'done',
}

type MoveError = {
  error: 'NOT_FOUND' | 'COLUMN_NOT_FOUND' | 'INVALID_TRANSITION'
  from?: TaskStatus
}

export const moveTaskToColumn = async (
  prisma: PrismaClient,
  input: { taskId: string; organizationId: string; columnId: string; actorId: string },
): Promise<TaskRecord | MoveError> => {
  const existing = await prisma.task.findFirst({
    where: { id: input.taskId, organizationId: input.organizationId },
    select: { id: true, status: true, projectId: true },
  })
  if (!existing) return { error: 'NOT_FOUND' }
  if (!existing.projectId) return { error: 'COLUMN_NOT_FOUND' }

  const column = await prisma.boardColumn.findFirst({
    where: { id: input.columnId, projectId: existing.projectId },
    select: { id: true, category: true },
  })
  if (!column) return { error: 'COLUMN_NOT_FOUND' }

  const target = CATEGORY_TO_STATUS[column.category]

  // Same lifecycle category → only re-pin the column, no status change.
  if (existing.status === target) {
    const task = await prisma.task.update({
      where: { id: existing.id },
      data: { columnId: column.id },
      include: taskInclude,
    })
    return mapTask(task)
  }

  if (!isValidTransition(existing.status, target)) {
    return { error: 'INVALID_TRANSITION', from: existing.status }
  }

  const task = await prisma.$transaction(async (tx) => {
    const { count } = await tx.task.updateMany({
      where: { id: existing.id, organizationId: input.organizationId, status: existing.status },
      data: { columnId: column.id, status: target },
    })
    if (count === 0) return null
    await tx.taskEvent.create({
      data: {
        taskId: existing.id,
        eventType: 'status_changed',
        payload: { by: input.actorId, from: existing.status, to: target, columnId: column.id },
      },
    })
    return tx.task.findFirst({ where: { id: existing.id }, include: taskInclude })
  })

  if (!task) return { error: 'INVALID_TRANSITION', from: existing.status }
  return mapTask(task)
}
