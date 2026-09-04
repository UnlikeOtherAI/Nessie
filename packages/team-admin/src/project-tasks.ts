import type { Prisma, PrismaClient, TaskPriority, TaskStatus } from '@prisma/client'
import { parseUserId, type AuthorizedActionContext } from '@nessie/schemas'
import { isAgentAccessibleToActor } from './access-checks.js'
import { mapProjectTask, projectTaskInclude, type ProjectTaskRecord } from './project-task-records.js'
import { isArchivedProjectTaskStatus, isProjectTaskTransitionValid } from './project-task-status.js'

export type AssignableProjectTaskUser = { id: string; displayName: string }

export type ProjectTaskVisibility = { accessibleProjectIds: string[]; actorUserId: string }

export const projectTaskVisibilityWhere = (visibility?: ProjectTaskVisibility) =>
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
    orderBy: [{ position: 'asc' }, { updatedAt: 'desc' }],
    take: 200,
  })
  return tasks.map(mapProjectTask)
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
  return task ? mapProjectTask(task) : null
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
  iterationId?: string
  storyPoints?: number
  priority?: TaskPriority
  dueDate?: Date | null
  assigneeUserId?: string
  assigneeAgentId?: string
  ownerUserId?: string
  assignmentAttention?: ProjectTaskAssignmentAttention
}

export type ProjectTaskCreateError = {
  error: 'ASSIGNEE_NOT_MEMBER' | 'ASSIGNEE_AGENT_NOT_FOUND' | 'OWNER_NOT_MEMBER' | 'PROJECT_NOT_FOUND' | 'ITERATION_NOT_FOUND'
}

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
  if (input.assigneeUserId && !(await isOrganizationMember(prisma, input.organizationId, input.assigneeUserId))) return { error: 'ASSIGNEE_NOT_MEMBER' }
  if (input.assigneeAgentId && !(await isAgentAccessibleToActor(prisma, input.actorContext, input.assigneeAgentId))) return { error: 'ASSIGNEE_AGENT_NOT_FOUND' }
  if (input.ownerUserId && !(await isOrganizationMember(prisma, input.organizationId, input.ownerUserId))) return { error: 'OWNER_NOT_MEMBER' }
  const status: TaskStatus = input.assigneeUserId || input.assigneeAgentId ? 'assigned' : 'inbox'
  const task = await prisma.$transaction(async (tx) => {
    const created = await tx.task.create({
      data: {
        organizationId: input.organizationId, projectId: input.projectId ?? null,
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
    return created
  })
  return mapProjectTask(task)
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
): Promise<ProjectTaskRecord | ProjectTaskAssignError> => {
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
    return task ? mapProjectTask(task) : { error: 'NOT_FOUND' }
  }
  const assigned = Boolean(userId || agentId)
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
  return task ? mapProjectTask(task) : { error: 'NOT_FOUND' }
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
      // An archived ticket has no board placement. Clear a legacy placement
      // when restoring as well, so the restored status selects its proper
      // board column instead of reviving a stale one.
      data: {
        status: input.status,
        ...(isArchivedProjectTaskStatus(existing.status) || isArchivedProjectTaskStatus(input.status)
          ? { columnId: null }
          : {}),
      },
    })
    if (count === 0) return null
    await tx.taskEvent.create({ data: { taskId: input.taskId, eventType: 'status_changed', payload: { by: input.actorId, from: existing.status, to: input.status } } })
    return tx.task.findFirst({ where: { id: input.taskId }, include: projectTaskInclude })
  })
  return task ? mapProjectTask(task) : { error: 'INVALID_TRANSITION', from: existing.status }
}

export type ProjectTaskUpdateFields = {
  title?: string
  purpose?: string | null
  detail?: string | null
  priority?: TaskPriority
  dueDate?: Date | null
  archivedAt?: Date | null
  storyPoints?: number | null
}

export const updateProjectTask = async (
  prisma: PrismaClient,
  input: { taskId: string; organizationId: string; fields: ProjectTaskUpdateFields },
): Promise<ProjectTaskRecord | { error: 'NOT_FOUND' }> => {
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
  return mapProjectTask(await prisma.task.update({ where: { id: existing.id }, data, include: projectTaskInclude }))
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
  return mapProjectTask(await prisma.task.update({
    where: { id: existing.id },
    data: { iterationId: input.iterationId },
    include: projectTaskInclude,
  }))
}

/** Archives only a single project, never an organisation-wide implicit set. */
export const archiveProjectDoneTasks = async (
  prisma: PrismaClient,
  input: { organizationId: string; projectId: string; olderThanDays?: number | null },
): Promise<{ count: number }> => {
  const now = new Date()
  const cutoff = input.olderThanDays && input.olderThanDays > 0
    ? new Date(now.getTime() - input.olderThanDays * 86_400_000)
    : null
  const { count } = await prisma.task.updateMany({
    where: { organizationId: input.organizationId, projectId: input.projectId, status: 'done', archivedAt: null, ...(cutoff ? { updatedAt: { lt: cutoff } } : {}) },
    data: { archivedAt: now },
  })
  return { count }
}
