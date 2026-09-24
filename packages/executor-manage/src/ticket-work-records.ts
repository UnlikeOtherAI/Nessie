import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { writeAuditEntryInTransaction } from '@nessie/db'
import {
  TICKET_WORK_LIVE_STATUSES,
  TICKET_WORK_THREAD_EVENT_LABELS,
  type TicketWorkActivityEventType,
  type TicketWorkActivityPayload,
  type TicketWorkStateReason,
  type TicketWorkStatus,
  type TicketWorkThreadEvent,
} from '@nessie/schemas'

import { lockTicketWorkQueue, renumberTicketWorkQueueInTransaction } from './executor-standing-policy-queue.js'
import { syncTicketWorkClock } from './ticket-work-clock.js'

/**
 * The work record's platform-owned transitions (docs/standards/ticket-work.md
 * → "Teardown, limits and session closes are the platform's"). Each runs in
 * the caller's transaction — the move that entered an end column, the edit
 * that disabled the trigger, the wake that found a limit spent — so a record
 * can never outlive the change that ended it.
 *
 * They live beside the standing policy's lifecycle, which ends records when a
 * fence ends the policy, rather than in team-admin: the executor fences that
 * end a policy are in this package.
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
    /** Why the work was where it left (T5): its offline machine, come back or stayed away. */
    previousReason?: TicketWorkStateReason
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
    ...(input.previousReason ? { previousReason: input.previousReason } : {}),
  }
  await tx.taskEvent.create({
    data: { taskId: input.work.taskId, eventType: input.eventType, payload },
  })
}

/**
 * One compact row in a work thread (`metadata.ticketWorkEvent`): why the
 * agent was woken, why the platform stopped it, or who cancelled its
 * reminder, labelled by `TICKET_WORK_THREAD_EVENT_LABELS`. Never ticket text:
 * the channel can be wider than the ticket's project. The one writer, which
 * team-admin re-exports.
 */
export const writeTicketWorkThreadRow = async (
  tx: Pick<Prisma.TransactionClient, 'message'>,
  input: { threadId: string; event: TicketWorkThreadEvent },
): Promise<void> => {
  await tx.message.create({
    data: {
      threadId: input.threadId,
      role: 'system',
      content: `${TICKET_WORK_THREAD_EVENT_LABELS[input.event.kind]}: ${input.event.summary}`,
      metadata: { ticketWorkEvent: input.event } as Prisma.InputJsonValue,
    },
  })
}

/**
 * `ticket.work.started`, `ticket.work.queued` and `ticket.work.ended`, in the
 * transaction that moved the record: the audit chain says what the platform
 * did with a ticket's work, beside the ticket's own history rows.
 */
export const writeTicketWorkAudit = async (
  tx: Prisma.TransactionClient,
  input: {
    action: 'ticket.work.started' | 'ticket.work.queued' | 'ticket.work.ended'
    by?: string | null
    metadata: Record<string, unknown>
    organizationId: string
    workId: string
  },
): Promise<void> => {
  const person = input.by && input.by !== 'system' && !input.by.startsWith('agent:') ? input.by : null
  await writeAuditEntryInTransaction(tx, {
    action: input.action,
    actorId: person ?? input.by ?? 'ticket-work',
    actorType: person ? 'user' : input.by?.startsWith('agent:') ? 'agent' : 'system',
    metadata: input.metadata as Prisma.InputJsonValue,
    organizationId: input.organizationId,
    outcome: 'success',
    requestId: `ticket-work:${input.workId}:${randomUUID()}`,
    resourceId: input.workId,
    resourceType: 'agent_ticket_work',
  })
}

/**
 * End one live record: its status and reason, its reminders cancelled, a
 * `work_ended` row on the ticket and `ticket.work.ended` on the audit chain.
 * The update is conditional on the record still being live, so a second end
 * racing this one changes nothing and writes no second row. Returns whether
 * this call ended it.
 */
export const endTicketWork = async (
  tx: Prisma.TransactionClient,
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
  // Queued work leaves its policy's queue: its lock first, before the row.
  const held = await tx.agentTicketWork.findUnique({ where: { id: input.work.id }, select: { policyId: true } })
  if (held?.policyId) await lockTicketWorkQueue(tx, held.policyId)
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
  // Ended work stops the hours clock at the moment it ended.
  await syncTicketWorkClock(tx, input.work.id, endedAt)
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
  const record = await tx.agentTicketWork.findUniqueOrThrow({
    where: { id: input.work.id },
    select: { executorId: true, organizationId: true, policyId: true },
  })
  // Work that ended while it was queued leaves its place: the rest move up.
  if (record.policyId) await renumberTicketWorkQueueInTransaction(tx, record.policyId)
  await writeTicketWorkAudit(tx, {
    action: 'ticket.work.ended',
    by: input.by ?? null,
    metadata: {
      executorId: record.executorId,
      policyId: record.policyId,
      reason: input.reason,
      status: input.status,
      taskId: input.work.taskId,
      triggerId: input.work.triggerId,
    },
    organizationId: record.organizationId,
    workId: input.work.id,
  })
  return true
}
