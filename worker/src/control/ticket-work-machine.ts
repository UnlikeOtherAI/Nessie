import type { Prisma } from '@prisma/client'
import {
  enforceTicketWorkLimitsInTransaction,
  executorHeartbeatCutoff,
  placeTicketWorkOnMachineInTransaction,
  recordTicketWorkActivity,
  writeTicketWorkAudit,
  type TicketWorkMachinePlacement,
} from '@nessie/executor-manage'
import type { TicketTriggerSkipReason } from '@nessie/schemas'

import type { DescribedWakeEvent } from './ticket-work-events.js'

/**
 * A ticket's work and its machine, at the moment a wake is decided
 * (docs/plans/2026-09-23-ticket-driven-agents/ticket-work.md → "The pool
 * queue"; docs/standards/ticket-work-machine-access.md). Assignment happens
 * here, at dispatch, never in run setup: run setup only binds the machine a
 * record is already pinned to.
 *
 * - A pickup, or a person moving parked work back, places the record on the
 *   policy's pool (`placeTicketWorkOnMachineInTransaction`). Its one wake then
 *   says what happened: work starts on a machine; no machine is free, so it is
 *   queued — one short, unbound `queued` wake whose facts give its place and
 *   how many machines are busy or offline, never which; or machine access is
 *   not set up or is paused — one short, unbound wake, only to read the ticket
 *   and comment.
 * - Any other wake of live work checks its limits and its machine first. Over
 *   a limit, the work stops instead of waking. A pinned machine that is
 *   offline starts no model run at all: the record waits for it
 *   (`machine_offline`, still holding its slot), and its reconnect wakes it (T5).
 */

type WorkRef = { agentId: string; id: string; taskId: string; triggerId: string | null }

const machinesPhrase = (busy: number, offline: number): string => {
  if (offline === 0) return busy === 1 ? 'its machine is busy with another ticket' : `all ${busy} machines are busy with other tickets`
  if (busy === 0) return offline === 1 ? 'its machine is offline' : `all ${offline} machines are offline`
  return `${busy} machine${busy === 1 ? ' is' : 's are'} busy with other tickets and ${offline} offline`
}

/** What the wake tells the agent, with where the machine placement left the work. */
const eventFor = (event: DescribedWakeEvent, placement: TicketWorkMachinePlacement): DescribedWakeEvent => {
  switch (placement.kind) {
    case 'assigned':
      return event
    case 'queued':
      return {
        ...event,
        reason: 'queued',
        summary: `queued: position ${placement.position}`,
        text: `${event.text} No machine can take it yet, because ${machinesPhrase(placement.busy, placement.offline)}: `
          + `it is queued at position ${placement.position}. You will be woken here when a machine frees. `
          + 'Never name a machine on the ticket or in this thread.',
      }
    case 'waiting':
      return {
        ...event,
        text: `${event.text} ${placement.reason === 'machine_access_suspended'
          ? 'Machine access for this trigger is paused until the machines\' owner confirms it again'
          : 'Machine access for this trigger is not set up'}, so no coding agent can work the ticket yet: read it and `
          + 'comment if that helps. The work waits until its owner sets machine access up, and you will be woken then.',
      }
  }
}

const statusOf = (placement: TicketWorkMachinePlacement) => placement.kind === 'assigned'
  ? { reason: null, status: 'active' as const }
  : placement.kind === 'queued'
    ? { reason: placement.reason, status: 'queued' as const }
    : { reason: placement.reason, status: 'waiting_machine' as const }

/**
 * Place work that needs a machine now — a pickup (`start`) or a resume — and
 * write what the ticket's history and the audit chain say of it. Returns the
 * event its one wake carries.
 */
export const placeTicketWorkForWake = async (
  tx: Prisma.TransactionClient,
  input: {
    by: string | null
    causeEventId?: string
    event: DescribedWakeEvent
    kind: 'resume' | 'start'
    organizationId: string
    startedByEventId?: string | null
    work: WorkRef
  },
): Promise<DescribedWakeEvent> => {
  const placement = await placeTicketWorkOnMachineInTransaction(tx, { workId: input.work.id })
  const { reason, status } = statusOf(placement)
  const cause = input.causeEventId ? { causeEventId: input.causeEventId } : {}
  await recordTicketWorkActivity(tx, {
    by: input.by, eventType: input.kind === 'start' ? 'work_started' : 'work_resumed', reason, status, work: input.work, ...cause,
  })
  const facts = {
    ...(placement.kind === 'assigned' ? { executorId: placement.executorId } : {}),
    policyId: placement.policyId,
    reason,
    status,
    taskId: input.work.taskId,
    triggerId: input.work.triggerId,
  }
  if (input.kind === 'start') {
    await writeTicketWorkAudit(tx, {
      action: 'ticket.work.started', by: input.by, organizationId: input.organizationId, workId: input.work.id,
      metadata: { ...facts, startedByEventId: input.startedByEventId ?? null },
    })
  }
  if (placement.kind === 'queued') {
    await recordTicketWorkActivity(tx, {
      by: input.by, eventType: 'work_queued', reason: placement.reason, status: 'queued', work: input.work, ...cause,
    })
    await writeTicketWorkAudit(tx, {
      action: 'ticket.work.queued', by: input.by, organizationId: input.organizationId, workId: input.work.id,
      metadata: { ...facts, busy: placement.busy, offline: placement.offline, position: placement.position },
    })
  }
  return eventFor(input.event, placement)
}

/**
 * Before live work is woken: stop it if it is over one of its policy's
 * limits, or let it wait if the machine it holds is offline. Returns the skip
 * the wake's delivery is written with, or null to wake it.
 */
export const holdTicketWorkBeforeWake = async (
  tx: Prisma.TransactionClient,
  input: { now?: Date; work: WorkRef },
): Promise<TicketTriggerSkipReason | null> => {
  const now = input.now ?? new Date()
  const [ended] = await enforceTicketWorkLimitsInTransaction(tx, { now, where: { id: input.work.id } })
  if (ended) return ended.reason
  const record = await tx.agentTicketWork.findUniqueOrThrow({
    where: { id: input.work.id },
    select: { executor: { select: { lastSeenAt: true, status: true } }, executorId: true, status: true },
  })
  const online = record.executor?.status === 'online' && record.executor.lastSeenAt !== null
    && record.executor.lastSeenAt >= executorHeartbeatCutoff(now)
  if (record.status !== 'active' || !record.executorId || online) return null
  await tx.agentTicketWork.update({
    where: { id: input.work.id },
    data: { stateReason: 'machine_offline', status: 'waiting_machine' },
  })
  await recordTicketWorkActivity(tx, {
    eventType: 'work_paused', reason: 'machine_offline', status: 'waiting_machine', work: input.work,
  })
  return 'machine_offline'
}
