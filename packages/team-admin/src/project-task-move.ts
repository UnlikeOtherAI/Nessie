import { Prisma, type PrismaClient, type TaskStatus } from '@prisma/client'
import { mapProjectTask, projectTaskInclude, type ProjectTaskRecord } from './project-task-records.js'
import { isProjectTaskTransitionValid } from './project-task-status.js'

const CATEGORY_TO_STATUS: Record<'todo' | 'in_progress' | 'review' | 'done', TaskStatus> = {
  todo: 'inbox',
  in_progress: 'in_progress',
  review: 'review',
  done: 'done',
}

export type ProjectTaskMoveError = {
  error: 'NOT_FOUND' | 'COLUMN_NOT_FOUND' | 'INVALID_TRANSITION'
  from?: TaskStatus
}

const reindexColumn = async (
  tx: Prisma.TransactionClient,
  organizationId: string,
  columnId: string,
  movedTaskId: string,
  index: number,
): Promise<void> => {
  const siblings = await tx.task.findMany({
    where: { organizationId, columnId, archivedAt: null },
    select: { id: true },
    orderBy: [{ position: 'asc' }, { updatedAt: 'desc' }],
  })
  const ordered = siblings.map((sibling) => sibling.id).filter((id) => id !== movedTaskId)
  ordered.splice(Math.min(Math.max(index, 0), ordered.length), 0, movedTaskId)
  if (ordered.length === 0) return
  const values = Prisma.join(
    ordered.map((id, position) => Prisma.sql`(${id}::uuid, ${position}::int)`),
  )
  await tx.$executeRaw`
    UPDATE "tasks" AS t
       SET "position" = v.position
      FROM (VALUES ${values}) AS v(id, position)
     WHERE t."id" = v.id
  `
}

/** The shared operation behind a board drag and a personal-assistant move. */
export const moveProjectTaskToColumn = async (
  prisma: PrismaClient,
  input: { taskId: string; organizationId: string; columnId: string; actorId: string; position?: number },
): Promise<ProjectTaskRecord | ProjectTaskMoveError> => {
  const existing = await prisma.task.findFirst({
    where: { id: input.taskId, organizationId: input.organizationId },
    select: { id: true, assigneeAgentId: true, assigneeUserId: true, status: true, projectId: true },
  })
  if (!existing) return { error: 'NOT_FOUND' }
  if (!existing.projectId) return { error: 'COLUMN_NOT_FOUND' }
  const column = await prisma.boardColumn.findFirst({
    where: { id: input.columnId, projectId: existing.projectId },
    select: { id: true, category: true },
  })
  if (!column) return { error: 'COLUMN_NOT_FOUND' }
  const target = CATEGORY_TO_STATUS[column.category]
  const needsTransition = existing.status !== target
  if (needsTransition && !isProjectTaskTransitionValid(existing.status, target)) {
    return { error: 'INVALID_TRANSITION', from: existing.status }
  }
  const shouldAutoAssignActor = target === 'in_progress' && !existing.assigneeUserId && !existing.assigneeAgentId
  const assignmentData = shouldAutoAssignActor ? { assigneeUserId: input.actorId, assigneeAgentId: null } : {}
  const task = await prisma.$transaction(async (tx) => {
    if (needsTransition) {
      const { count } = await tx.task.updateMany({
        where: { id: existing.id, organizationId: input.organizationId, status: existing.status },
        data: { columnId: column.id, status: target, ...assignmentData },
      })
      if (count === 0) return null
      await tx.taskEvent.create({
        data: { taskId: existing.id, eventType: 'status_changed', payload: { by: input.actorId, from: existing.status, to: target, columnId: column.id } },
      })
    } else {
      await tx.task.update({ where: { id: existing.id }, data: { columnId: column.id, ...assignmentData } })
    }
    if (shouldAutoAssignActor) {
      await tx.taskEvent.create({
        data: { taskId: existing.id, eventType: 'assigned', payload: { by: input.actorId, assigneeUserId: input.actorId, assigneeAgentId: null, reason: 'moved_to_in_progress' } },
      })
    }
    if (input.position !== undefined) {
      await reindexColumn(tx, input.organizationId, column.id, existing.id, input.position)
    }
    return tx.task.findFirst({ where: { id: existing.id }, include: projectTaskInclude })
  })
  if (!task) return { error: 'INVALID_TRANSITION', from: existing.status }
  return mapProjectTask(task)
}
