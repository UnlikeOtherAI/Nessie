import type { Prisma, PrismaClient, TaskStatus } from '@prisma/client'
import {
  parseAgentId,
  parseOrganizationId,
  parseTaskId,
  parseUserId,
} from '@nessie/schemas'
import type { AssignableUser, TaskRecord } from '../contracts.js'

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  inbox: ['assigned', 'in_progress', 'cancelled'],
  assigned: ['in_progress', 'review', 'inbox', 'cancelled'],
  in_progress: ['review', 'awaiting_approval', 'done', 'failed', 'cancelled'],
  review: ['in_progress', 'done', 'failed', 'cancelled'],
  awaiting_approval: ['in_progress', 'done', 'failed', 'cancelled'],
  done: ['in_progress'],
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
  agentId: task.agentId ? parseAgentId(task.agentId) : null,
  parentTaskId: task.parentTaskId ? parseTaskId(task.parentTaskId) : null,
  runId: task.runId ? (task.runId as TaskRecord['runId']) : null,
  status: task.status,
  title: task.title,
  purpose: task.purpose,
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
  filters: { assigneeUserId?: string; ownerUserId?: string; status?: TaskStatus },
): Promise<TaskRecord[]> => {
  const tasks = await prisma.task.findMany({
    where: {
      organizationId,
      ...(filters.assigneeUserId ? { assigneeUserId: filters.assigneeUserId } : {}),
      ...(filters.ownerUserId ? { ownerUserId: filters.ownerUserId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
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
  assigneeUserId?: string
  ownerUserId?: string
}

type TaskError = { error: 'ASSIGNEE_NOT_MEMBER' | 'OWNER_NOT_MEMBER' }

export const createHumanTask = async (
  prisma: PrismaClient,
  input: CreateTaskInput,
): Promise<TaskRecord | TaskError> => {
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
      createdByUserId: input.createdByUserId,
      title: input.title,
      purpose: input.purpose ?? null,
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
