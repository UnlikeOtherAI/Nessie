import { Prisma } from '@prisma/client'

import { resolveProjectTaskDetailPlacement } from './board-placement.js'

/**
 * The one lock every change to a ticket's work takes, on the ticket's own
 * row (docs/standards/ticket-work.md → "Teardown, limits and session closes
 * are the platform's").
 *
 * A move tears its work down in its own transaction, but the record it would
 * tear down may not exist yet: the pickup that creates it is decided by an
 * asynchronous dispatch, a moment after the move that started it. Without one
 * lock a quick misdrop — Backlog → In progress → Backlog before the worker
 * drains the first job — found no record to end in the second move, and the
 * first job then started work on a ticket already back in Backlog. So the
 * move's teardown and every dispatcher start, resume and end take this row
 * lock first, and then read where the ticket is: whichever goes second sees
 * what the first committed.
 *
 * Re-entrant within a transaction, and a move that changed the ticket's
 * status already holds it.
 */
export const lockTicketForWork = async (
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  taskId: string,
): Promise<void> => {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "tasks" WHERE "id" = ${taskId}::uuid FOR UPDATE`)
}

/**
 * Where the ticket renders now on its home board, read under the lock — the
 * column a start, a resume or an end is decided against, rather than the one
 * the event that asked for it named. Null when the ticket is on no board or
 * in no column (archived work).
 */
export const lockTicketColumn = async (
  tx: Pick<Prisma.TransactionClient, '$queryRaw' | 'task' | 'board' | 'taskBoardPlacement'>,
  taskId: string,
): Promise<string | null> => {
  await lockTicketForWork(tx, taskId)
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true, boardId: true, status: true, archivedAt: true },
  })
  if (!task) return null
  return (await resolveProjectTaskDetailPlacement(tx, task))?.columnId ?? null
}
