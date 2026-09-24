import type { Prisma } from '@prisma/client'
import {
  TICKET_WORK_LIVE_STATUSES,
  type TicketWorkActivityEventType,
  type TicketWorkActivityPayload,
  type TicketWorkStateReason,
  type TicketWorkStatus,
} from '@nessie/schemas'

/**
 * The work record's platform-owned transitions (docs/standards/ticket-work.md
 * → "Teardown, limits and session closes are the platform's"). Each runs in
 * the caller's transaction — the move that entered an end column, the edit
 * that disabled the trigger, the wake that found a limit spent — so a record
 * can never outlive the change that ended it.
 */

export type TicketWorkRecordRef = { id: string; taskId: string; triggerId: string | null; agentId: string }

type ActivityWriter = Pick<Prisma.TransactionClient, 'taskEvent'>

/**
 * One `work_*` row in the ticket's history. `by` names who caused it, as a
 * `TaskEvent.by` does; the platform acting on its own names nobody.
 */
export const recordTicketWorkActivity = async (
  tx: ActivityWriter,
  input: {
    work: TicketWorkRecordRef
    eventType: TicketWorkActivityEventType
    status: TicketWorkStatus
    reason: TicketWorkStateReason | null
    by?: string | null
    /** The `column_entered` whose move caused it, when a move did. */
    causeEventId?: string
  },
): Promise<void> => {
  const payload: TicketWorkActivityPayload = {
    ...(input.by && input.by !== 'system' ? { by: input.by } : {}),
    origin: { kind: 'system' },
    workId: input.work.id,
    triggerId: input.work.triggerId,
    agentId: input.work.agentId,
    status: input.status,
    reason: input.reason,
    ...(input.causeEventId ? { causeEventId: input.causeEventId } : {}),
  }
  await tx.taskEvent.create({
    data: { taskId: input.work.taskId, eventType: input.eventType, payload },
  })
}

type EndWriter = ActivityWriter & Pick<Prisma.TransactionClient, 'agentTicketWork' | 'agentReminder'>

/**
 * End one live record: its status and reason, its reminders cancelled, and a
 * `work_ended` row on the ticket. The update is conditional on the record
 * still being live, so a second end racing this one changes nothing and
 * writes no second row. Returns whether this call ended it.
 */
export const endTicketWork = async (
  tx: EndWriter,
  input: {
    work: TicketWorkRecordRef
    status: Extract<TicketWorkStatus, 'done' | 'cancelled' | 'failed'>
    reason: TicketWorkStateReason
    /** A `TaskEvent.by`: the mover, `agent:<id>`, or `system`. */
    by?: string | null
    /** The `column_entered` whose move ended it; its end wake is matched by it. */
    causeEventId?: string
  },
): Promise<boolean> => {
  const endedAt = new Date()
  const { count } = await tx.agentTicketWork.updateMany({
    where: { id: input.work.id, status: { in: [...TICKET_WORK_LIVE_STATUSES] } },
    data: {
      status: input.status,
      stateReason: input.reason,
      endedAt,
      endedReason: input.reason,
      endedBy: input.by ?? 'system',
    },
  })
  if (count === 0) return false
  await tx.agentReminder.updateMany({
    where: { workId: input.work.id, status: 'pending' },
    data: { status: 'cancelled', cancelledReason: 'work_ended' },
  })
  await recordTicketWorkActivity(tx, {
    work: input.work,
    eventType: 'work_ended',
    status: input.status,
    reason: input.reason,
    by: input.by ?? null,
    ...(input.causeEventId ? { causeEventId: input.causeEventId } : {}),
  })
  return true
}
