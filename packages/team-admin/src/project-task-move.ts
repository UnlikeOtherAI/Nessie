import { Prisma, type PrismaClient, type TaskStatus } from '@prisma/client'
import {
  BoardColumnStateBindingsSchema,
  CATEGORY_TO_STATUS,
  type BoardColumnStateBinding,
  statusToCategory,
} from '@nessie/schemas'

import type { BoardSourceWriteBack, BoardSourceWriteBackError } from './board-source-writeback.js'

import { resolveBoardPlacement } from './board-placement.js'
import { mapProjectTask, projectTaskInclude, type ProjectTaskRecord } from './project-task-records.js'
import { isProjectTaskTransitionValid } from './project-task-status.js'

export type ProjectTaskMoveError =
  | { error: 'NOT_FOUND' | 'COLUMN_NOT_FOUND' | 'INVALID_TRANSITION'; from?: TaskStatus }
  | BoardSourceWriteBackError

/**
 * Give every task currently rendered in this column on this board an explicit
 * placement, in the order the person saw, then slot the moved task in at
 * `index`.
 *
 * Materialising the whole column matters: before the drag, most rows have no
 * placement and are ordered by `updatedAt desc`. Writing only the moved row's
 * position would leave the rest implicitly ordered, so the next task anyone
 * touched would reshuffle the column under them. After one drag the column's
 * order on this board is fully explicit and stable.
 */
const reindexBoardColumn = async (
  tx: Prisma.TransactionClient,
  board: { id: string; columns: { id: string; category: string; position: number }[] },
  column: { id: string; category: string },
  movedTaskId: string,
  projectId: string,
  index: number,
): Promise<void> => {
  const candidates = await tx.task.findMany({
    where: { projectId, archivedAt: null },
    select: { id: true, status: true, archivedAt: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  })
  const pins = await tx.taskBoardPlacement.findMany({
    where: { boardId: board.id },
    select: { taskId: true, columnId: true, position: true },
  })
  const pinByTask = new Map(pins.map((pin) => [pin.taskId, pin]))

  const inColumn = candidates.filter((task) => {
    if (task.id === movedTaskId) return false
    const placement = resolveBoardPlacement(task, board.columns, pinByTask.get(task.id))
    return placement?.columnId === column.id
  })
  // Placed rows keep their order; unplaced rows follow in `updatedAt desc` —
  // exactly what `orderForRender` renders, so the write matches what was seen.
  const positioned = inColumn
    .filter((task) => pinByTask.get(task.id)?.columnId === column.id)
    .sort(
      (a, b) =>
        (pinByTask.get(a.id)?.position ?? 0) - (pinByTask.get(b.id)?.position ?? 0),
    )
  const rest = inColumn.filter((task) => pinByTask.get(task.id)?.columnId !== column.id)
  const ordered = [...positioned, ...rest].map((task) => task.id)
  ordered.splice(Math.min(Math.max(index, 0), ordered.length), 0, movedTaskId)

  if (ordered.length === 0) return
  // One statement rather than one upsert per card: a busy column is hundreds
  // of rows, and the drag is inside a transaction a person is waiting on.
  const values = Prisma.join(
    ordered.map(
      (taskId, position) =>
        Prisma.sql`(${taskId}::uuid, ${board.id}::uuid, ${column.id}::uuid, ${position}::int, now())`,
    ),
  )
  await tx.$executeRaw`
    INSERT INTO "task_board_placements" ("task_id", "board_id", "column_id", "position", "updated_at")
    VALUES ${values}
    ON CONFLICT ("task_id", "board_id")
    DO UPDATE SET "column_id" = EXCLUDED."column_id",
                  "position"  = EXCLUDED."position",
                  "updated_at" = now()
  `
}

/** The shared operation behind a board drag and a personal-assistant move. */
export const moveProjectTaskToColumn = async (
  prisma: PrismaClient,
  input: {
    taskId: string
    organizationId: string
    columnId: string
    actorId: string
    position?: number
  },
  /**
   * Injected by the API and the worker alike. Absent means "no source can be
   * involved" — the caller has none configured — and a mirrored task then moves
   * locally only, which is the behaviour before sources existed.
   */
  writeBack?: BoardSourceWriteBack,
): Promise<ProjectTaskRecord | ProjectTaskMoveError> => {
  const existing = await prisma.task.findFirst({
    where: { id: input.taskId, organizationId: input.organizationId },
    select: {
      id: true,
      assigneeAgentId: true,
      assigneeUserId: true,
      status: true,
      projectId: true,
    },
  })
  if (!existing) return { error: 'NOT_FOUND' }
  if (!existing.projectId) return { error: 'COLUMN_NOT_FOUND' }

  // The column names its board, and the board names its project — so a column
  // id from another project is a 404 rather than a cross-project move.
  const column = await prisma.boardColumn.findFirst({
    where: { id: input.columnId, board: { projectId: existing.projectId } },
    select: {
      id: true,
      category: true,
      stateBindings: true,
      board: {
        select: {
          id: true,
          columns: { select: { id: true, category: true, position: true } },
        },
      },
    },
  })
  if (!column) return { error: 'COLUMN_NOT_FOUND' }

  const target = CATEGORY_TO_STATUS[column.category]
  const needsTransition = existing.status !== target
  if (needsTransition && !isProjectTaskTransitionValid(existing.status, target)) {
    return { error: 'INVALID_TRANSITION', from: existing.status }
  }
  // The vendor is asked first, and only a success reaches the database — so a
  // refused Jira transition snaps the drag back with a reason rather than
  // leaving the board disagreeing with the ticket.
  if (writeBack && needsTransition) {
    const bindings = parseStateBindings(column.stateBindings)
    const outcome = await writeBack.apply({
      taskId: existing.id,
      change: {},
      category: statusToCategory(target) ?? undefined,
      boundStateId: bindings[0]?.externalStateId ?? null,
    })
    if (outcome && 'error' in outcome) return outcome
  }

  const shouldAutoAssignActor =
    target === 'in_progress' && !existing.assigneeUserId && !existing.assigneeAgentId
  const assignmentData = shouldAutoAssignActor
    ? { assigneeUserId: input.actorId, assigneeAgentId: null }
    : {}

  const task = await prisma.$transaction(async (tx) => {
    if (needsTransition) {
      const { count } = await tx.task.updateMany({
        where: { id: existing.id, organizationId: input.organizationId, status: existing.status },
        data: { status: target as TaskStatus, ...assignmentData },
      })
      if (count === 0) return null
      await tx.taskEvent.create({
        data: {
          taskId: existing.id,
          eventType: 'status_changed',
          payload: {
            by: input.actorId,
            from: existing.status,
            to: target,
            boardId: column.board.id,
            columnId: column.id,
          },
        },
      })
    } else if (Object.keys(assignmentData).length > 0) {
      await tx.task.update({ where: { id: existing.id }, data: assignmentData })
    }
    if (shouldAutoAssignActor) {
      await tx.taskEvent.create({
        data: {
          taskId: existing.id,
          eventType: 'assigned',
          payload: {
            by: input.actorId,
            assigneeUserId: input.actorId,
            assigneeAgentId: null,
            reason: 'moved_to_in_progress',
          },
        },
      })
    }

    await tx.taskBoardPlacement.upsert({
      where: { taskId_boardId: { taskId: existing.id, boardId: column.board.id } },
      create: {
        taskId: existing.id,
        boardId: column.board.id,
        columnId: column.id,
        position: input.position ?? 0,
      },
      update: { columnId: column.id, position: input.position ?? 0 },
    })
    // The status changed, so a pin on any *other* board that pointed at a
    // column of the old category is now stale. `resolveBoardPlacement` would
    // ignore it, but data the board itself wrote should not be left wrong.
    if (needsTransition) await dropStalePlacements(tx, existing.id, column.board.id)

    if (input.position !== undefined) {
      await reindexBoardColumn(
        tx,
        column.board,
        column,
        existing.id,
        existing.projectId as string,
        input.position,
      )
    }
    return tx.task.findFirst({ where: { id: existing.id }, include: projectTaskInclude })
  })
  if (!task) return { error: 'INVALID_TRANSITION', from: existing.status }
  return mapProjectTask(task)
}

/**
 * Delete placements whose column no longer matches the task's status. Called
 * after any status change the board did not itself make on that board.
 */
export const dropStalePlacements = async (
  tx: Prisma.TransactionClient,
  taskId: string,
  exceptBoardId?: string,
): Promise<void> => {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: { status: true },
  })
  if (!task) return
  const category = statusToCategory(task.status)
  await tx.taskBoardPlacement.deleteMany({
    where: {
      taskId,
      ...(exceptBoardId ? { NOT: { boardId: exceptBoardId } } : {}),
      ...(category
        ? { column: { category: { not: category } } }
        : {}),
    },
  })
}

/**
 * The external states a column binds. A bound column places items in those
 * states and writes back the first one, which is what lets "Code review" and
 * "QA" be two Review columns that mean different things upstream.
 */
export const parseStateBindings = (value: unknown): BoardColumnStateBinding[] => {
  const parsed = BoardColumnStateBindingsSchema.safeParse(value)
  return parsed.success ? parsed.data : []
}
