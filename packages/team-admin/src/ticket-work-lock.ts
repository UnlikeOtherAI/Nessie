import { Prisma } from '@prisma/client'
import { TicketChangedStoredConfigSchema } from '@nessie/schemas'

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

/**
 * Whether a ticket is still in its trigger's flow: it renders on the pinned
 * board, in a column, and not in one the trigger ends work in. The standing
 * policy binder asks this before it lends a machine
 * (docs/standards/ticket-work-machine-access.md → "Binding"), so a ticket
 * moved to another board, archived, or sitting in an end column its teardown
 * has not caught up with gets no machine. An unreadable config is out of flow.
 */
export const ticketInWorkFlow = async (
  prisma: Pick<Prisma.TransactionClient, 'board' | 'boardColumn' | 'task' | 'taskBoardPlacement'>,
  input: { boardId: string; config: unknown; taskId: string },
): Promise<boolean> => {
  const config = TicketChangedStoredConfigSchema.safeParse(input.config)
  if (!config.success || config.data.boardId !== input.boardId) return false
  const task = await prisma.task.findUnique({
    where: { id: input.taskId },
    select: { id: true, projectId: true, boardId: true, status: true, archivedAt: true },
  })
  if (!task || task.archivedAt) return false
  const placement = await resolveProjectTaskDetailPlacement(prisma, task)
  if (!placement?.columnId || placement.boardId !== input.boardId) return false
  const column = await prisma.boardColumn.findFirst({
    where: { boardId: input.boardId, id: placement.columnId },
    select: { category: true, id: true },
  })
  return Boolean(column) && !config.data.endOn.some((entry) =>
    ('id' in entry ? entry.id === column?.id : entry.category === column?.category))
}
