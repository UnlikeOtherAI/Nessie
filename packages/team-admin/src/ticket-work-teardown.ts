import type { Prisma } from '@prisma/client'
import {
  TICKET_WORK_LIVE_STATUSES,
  TicketChangedStoredConfigSchema,
  type TicketEndOn,
} from '@nessie/schemas'

import { syncTicketWorkClock } from './ticket-work-clock.js'
import { lockTicketForWork } from './ticket-work-lock.js'
import { endTicketWork, recordTicketWorkActivity } from './ticket-work-records.js'

/**
 * What entering a column does to the ticket's live work, **inside the
 * transaction that moved it**, whoever moved it — a person, a board source, or
 * the trigger's own agent (docs/standards/ticket-work.md → "Teardown, limits
 * and session closes are the platform's"). The model is never asked to end its
 * own work: the agent's move to Done suppresses its own wake, so if teardown
 * waited for the agent it would never happen.
 *
 * - An `endOn` column ends the record: `done` in a done-category column (with
 *   `merged` when a merged pull request is on record, `left_flow` otherwise),
 *   `cancelled` anywhere else. The dispatcher then sends the agent one
 *   machine-less `ticket_moved` wake, only so it can comment.
 * - A review-category column that is neither in `endOn` nor a start-work
 *   column parks the record: it stays live, and a person's move back into a
 *   start-work column resumes it (the dispatcher decides that, under the
 *   origin rule, so a token's or an agent's move back leaves it parked).
 * - Any other column changes nothing here.
 *
 * Both take the ticket's work lock first (`lockTicketForWork`), so a pickup
 * the dispatcher is deciding at the same moment is either already committed
 * and ended here, or waits and sees where this move put the ticket.
 */
export type TicketWorkTeardownWriter = Pick<
  Prisma.TransactionClient,
  'agentTicketWork' | 'agentReminder' | 'boardColumn' | 'taskEvent' | '$queryRaw'
>

/** Whether an `endOn` list ends the work in this column, of whatever board. */
const endsWorkIn = (endOn: readonly TicketEndOn[], column: { id: string; category: string }): boolean =>
  endOn.some((entry) => ('id' in entry ? entry.id === column.id : entry.category === column.category))

const liveRecords = (tx: TicketWorkTeardownWriter, taskId: string) =>
  tx.agentTicketWork.findMany({
    where: { taskId, status: { in: [...TICKET_WORK_LIVE_STATUSES] } },
    select: {
      id: true,
      taskId: true,
      triggerId: true,
      agentId: true,
      status: true,
      lastPrState: true,
      trigger: { select: { config: true } },
    },
  })

export const applyTicketWorkColumnEntry = async (
  tx: TicketWorkTeardownWriter,
  input: {
    taskId: string
    toColumnId: string
    /** The move's `TaskEvent.by`: who the record's end names. */
    by?: string
    /** The move's `column_entered`, named on the rows it causes. */
    eventId?: string
  },
): Promise<void> => {
  await lockTicketForWork(tx, input.taskId)
  const records = await liveRecords(tx, input.taskId)
  if (records.length === 0) return
  const column = await tx.boardColumn.findUnique({
    where: { id: input.toColumnId },
    select: { id: true, category: true },
  })
  if (!column) return
  const cause = input.eventId ? { causeEventId: input.eventId } : {}
  for (const record of records) {
    // A trigger deleted without ending its records first, or one whose
    // configuration no longer parses, says nothing about where work ends.
    const config = TicketChangedStoredConfigSchema.safeParse(record.trigger?.config)
    if (!config.success) continue
    if (endsWorkIn(config.data.endOn, column)) {
      const status = column.category === 'done' ? 'done' : 'cancelled'
      await endTicketWork(tx, {
        work: record,
        status,
        reason: status === 'done' && record.lastPrState === 'MERGED' ? 'merged' : 'left_flow',
        by: input.by ?? 'system',
        ...cause,
      })
      continue
    }
    const pickup = new Set(config.data.pickup?.columnIds ?? [])
    if (column.category === 'review' && !pickup.has(column.id) && record.status !== 'parked') {
      await tx.agentTicketWork.update({
        where: { id: record.id },
        data: { status: 'parked', stateReason: null },
      })
      // Parked work waits for people, so its hours clock pauses.
      await syncTicketWorkClock(tx, record.id)
      await recordTicketWorkActivity(tx, {
        work: record, eventType: 'work_paused', status: 'parked', reason: null, by: input.by ?? null, ...cause,
      })
    }
  }
}

/**
 * The ticket left every column — archived, by a person, a board source or
 * the agent's own `ticket_transition` to cancelled or failed. Archived work
 * belongs to no column, so no `column_entered` is written and no end column
 * can match it; its live work ends here instead, `cancelled` with
 * `left_flow`, in the same transaction. Nothing wakes the agent: its ticket
 * is gone from the board.
 */
export const applyTicketWorkLeftBoard = async (
  tx: TicketWorkTeardownWriter,
  input: { taskId: string; by?: string },
): Promise<void> => {
  await lockTicketForWork(tx, input.taskId)
  for (const record of await liveRecords(tx, input.taskId)) {
    await endTicketWork(tx, { work: record, status: 'cancelled', reason: 'left_flow', by: input.by ?? 'system' })
  }
}
