import type { Prisma } from '@prisma/client'
import type { TaskEventOrigin } from '@nessie/schemas'

import { resolveProjectTaskDetailPlacement } from './board-placement.js'
import { recordTaskEvent, type TaskEventScope, type TaskEventWriter } from './task-event-dispatch.js'

type PlacementReader = Pick<Prisma.TransactionClient, 'board' | 'taskBoardPlacement'>

/**
 * The column a ticket renders in on its home board (`Task.boardId`, else the
 * project's default), by the same rule the board draws it with. Null when the
 * ticket is on no board or in no column (archived work).
 */
export const resolveHomeColumnId = async (
  db: PlacementReader,
  task: {
    id: string
    projectId: string | null
    boardId: string | null
    status: string
    archivedAt: Date | string | null
  },
): Promise<string | null> =>
  (await resolveProjectTaskDetailPlacement(db, task))?.columnId ?? null

/**
 * `column_entered`, written whenever the column a ticket renders in changes —
 * including between two columns of the same category, which changes no
 * status and so writes no `status_changed`. A reorder within one column, or a
 * change that leaves the ticket in no column, writes nothing.
 */
export const recordColumnEntered = async (
  tx: TaskEventWriter,
  input: {
    taskId: string
    scope: TaskEventScope
    fromColumnId: string | null
    toColumnId: string | null
    authorship: { by?: string; origin: TaskEventOrigin }
  },
): Promise<{ id: string } | null> => {
  if (!input.toColumnId || input.fromColumnId === input.toColumnId) return null
  return recordTaskEvent(tx, {
    taskId: input.taskId,
    eventType: 'column_entered',
    payload: {
      ...input.authorship,
      fromColumnId: input.fromColumnId,
      toColumnId: input.toColumnId,
    },
    scope: input.scope,
  })
}
