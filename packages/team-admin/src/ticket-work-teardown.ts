import type { Prisma } from '@prisma/client'
import {
  TICKET_WORK_LIVE_STATUSES,
  TicketChangedStoredConfigSchema,
  type TicketEndOn,
} from '@nessie/schemas'

import { endTicketWork } from './ticket-work-records.js'

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
 */
export type TicketWorkTeardownWriter = Pick<
  Prisma.TransactionClient,
  'agentTicketWork' | 'agentReminder' | 'boardColumn' | 'taskEvent'
>

/** Whether an `endOn` list ends the work in this column, of whatever board. */
const endsWorkIn = (endOn: readonly TicketEndOn[], column: { id: string; category: string }): boolean =>
  endOn.some((entry) => ('id' in entry ? entry.id === column.id : entry.category === column.category))

export const applyTicketWorkColumnEntry = async (
  tx: TicketWorkTeardownWriter,
  input: {
    taskId: string
    toColumnId: string
    /** The move's `TaskEvent.by`: who the record's end names. */
    by?: string
  },
): Promise<void> => {
  const records = await tx.agentTicketWork.findMany({
    where: { taskId: input.taskId, status: { in: [...TICKET_WORK_LIVE_STATUSES] } },
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
  if (records.length === 0) return
  const column = await tx.boardColumn.findUnique({
    where: { id: input.toColumnId },
    select: { id: true, category: true },
  })
  if (!column) return
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
      })
      continue
    }
    const pickup = new Set(config.data.pickup?.columnIds ?? [])
    if (column.category === 'review' && !pickup.has(column.id) && record.status !== 'parked') {
      await tx.agentTicketWork.update({
        where: { id: record.id },
        data: { status: 'parked', stateReason: null },
      })
    }
  }
}
