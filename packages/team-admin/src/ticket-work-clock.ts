import type { Prisma } from '@prisma/client'
import { TICKET_WORK_LIVE_STATUSES } from '@nessie/schemas'

/**
 * A work record's hours clock and its open question
 * (docs/standards/ticket-work.md → "Reminders, the quiet wake and the sweep").
 *
 * `activeMs` counts the time a record spends `active` with no question
 * waiting for a person: it is paused while the work is queued, parked or
 * waiting for a machine, and while the agent's latest comment on the ticket
 * asked the people on it something (`awaitingAnswerAt`) and nobody has
 * answered. `clockStartedAt` is when it last started running, null while it is
 * paused. Every write that changes either fact calls `syncTicketWorkClock` in
 * its own transaction, which folds the time since `clockStartedAt` into
 * `activeMs` and starts or pauses the clock for the record's new state.
 *
 * An open question is structural, never read from the comment's words: the
 * agent says so with `ticket_comment_add`'s `awaitsAnswer`.
 */

type ClockWriter = Pick<Prisma.TransactionClient, 'agentTicketWork'>

/** Whether the clock runs for a record in this state. */
export const ticketWorkClockRuns = (record: { status: string; awaitingAnswerAt: Date | null }): boolean =>
  record.status === 'active' && record.awaitingAnswerAt === null

/** `activeMs` as of `at`, the running stretch included. */
export const ticketWorkActiveMs = (
  record: { activeMs: bigint; clockStartedAt: Date | null },
  at: Date = new Date(),
): bigint => record.activeMs
  + (record.clockStartedAt ? BigInt(Math.max(0, at.getTime() - record.clockStartedAt.getTime())) : 0n)

/**
 * Bring one record's clock into line with its status and open question. The
 * write is conditional on the `clockStartedAt` it read, so two transitions
 * racing on one record never fold the same stretch twice.
 */
export const syncTicketWorkClock = async (tx: ClockWriter, workId: string, at: Date = new Date()): Promise<void> => {
  const record = await tx.agentTicketWork.findUnique({
    where: { id: workId },
    select: { status: true, awaitingAnswerAt: true, clockStartedAt: true },
  })
  if (!record) return
  const runs = ticketWorkClockRuns(record)
  // Running and should run, or paused and should stay paused: nothing to do.
  if ((record.clockStartedAt !== null) === runs) return
  const elapsed = record.clockStartedAt ? Math.max(0, at.getTime() - record.clockStartedAt.getTime()) : 0
  await tx.agentTicketWork.updateMany({
    where: { id: workId, clockStartedAt: record.clockStartedAt },
    data: { activeMs: { increment: BigInt(elapsed) }, clockStartedAt: runs ? at : null },
  })
}

/**
 * The trigger's agent commented on its ticket, by any door. A comment that
 * awaits an answer opens the question on each of the agent's live records for
 * the ticket — quiet wakes stop and the clock pauses — and any other comment
 * closes it, because the question is only ever the agent's latest comment.
 * Runs in the comment's own transaction.
 */
export const applyTicketWorkAgentComment = async (
  tx: ClockWriter,
  input: { taskId: string; agentId: string; awaitsAnswer: boolean; at?: Date },
): Promise<void> => {
  const at = input.at ?? new Date()
  const records = await tx.agentTicketWork.findMany({
    where: { taskId: input.taskId, agentId: input.agentId, status: { in: [...TICKET_WORK_LIVE_STATUSES] } },
    select: { id: true, awaitingAnswerAt: true },
  })
  for (const record of records) {
    if (!input.awaitsAnswer && record.awaitingAnswerAt === null) continue
    await tx.agentTicketWork.update({
      where: { id: record.id },
      data: { awaitingAnswerAt: input.awaitsAnswer ? at : null },
    })
    await syncTicketWorkClock(tx, record.id, at)
  }
}

/**
 * A comment on the ticket from anyone but an agent — a person, or a connected
 * board's own user — answers every question open on the ticket's live work,
 * in the comment's own transaction: the question closes and the clock runs
 * again, whatever the trigger follows and whoever wrote it. Closing re-arms
 * only the quiet wake; it grants the author nothing. Returns the records whose
 * question it closed, which the comment's `comment_added` event names
 * (`answeredWorkIds`) so the dispatcher wakes them for it even when their
 * trigger does not follow comments — still only for a board editor.
 */
export const answerTicketWorkQuestions = async (
  tx: ClockWriter,
  input: { taskId: string; at?: Date },
): Promise<string[]> => {
  const open = await tx.agentTicketWork.findMany({
    where: { taskId: input.taskId, status: { in: [...TICKET_WORK_LIVE_STATUSES] }, awaitingAnswerAt: { not: null } },
    select: { id: true },
  })
  const closed: string[] = []
  for (const { id } of open) {
    if (await closeTicketWorkQuestion(tx, id, input.at)) closed.push(id)
  }
  return closed
}

/**
 * A person's event woke the record — a comment, a thread message, a move — so
 * whatever the agent asked has had its answer: the question closes and the
 * clock runs again. Returns whether a question was open.
 */
export const closeTicketWorkQuestion = async (
  tx: ClockWriter,
  workId: string,
  at: Date = new Date(),
): Promise<boolean> => {
  const { count } = await tx.agentTicketWork.updateMany({
    where: { id: workId, awaitingAnswerAt: { not: null } },
    data: { awaitingAnswerAt: null },
  })
  if (count > 0) await syncTicketWorkClock(tx, workId, at)
  return count > 0
}
