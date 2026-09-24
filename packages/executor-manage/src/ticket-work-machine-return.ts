import { Prisma, type PrismaClient } from '@prisma/client'
import { StandingPolicyPinnedTermsSchema, type ExecutorStandingPolicySuspendedReason } from '@nessie/schemas'

import { executorHeartbeatCutoff } from './executor-liveness.js'
import { closeTicketWorkSessionsInTransaction } from './executor-standing-policy-lifecycle.js'
import { standingPolicyMachineDigests } from './executor-standing-policy-machines.js'
import {
  enqueueTicketWorkSweep,
  queueTicketWorkInTransaction,
  standingPolicyPoolReason,
} from './executor-standing-policy-pool.js'
import { standingPolicyLimitsOf, standingPolicyTermsDigest, standingPolicyTermsOf } from './executor-standing-policy-terms.js'
import { syncTicketWorkClock } from './ticket-work-clock.js'
import { recordTicketWorkActivity, writeTicketWorkAudit } from './ticket-work-records.js'

/**
 * A ticket's work and the machine it waits for (T5; docs/plans/2026-09-23-ticket-driven-agents/ticket-work.md
 * → "The pool queue"; docs/standards/ticket-work-machine-access.md). Work whose pinned machine
 * was offline when a wake came waits for it (`waiting_machine`, `machine_offline`), keeping the
 * machine's slot. Two things end the wait, each in the caller's transaction, which holds the
 * ticket's work lock and its thread's run slot:
 *
 * - **The machine comes back** (`resumeTicketWorkOnItsMachineInTransaction`): the work is
 *   `active` on it again, its hours clock running, with a `work_resumed` row that says the
 *   machine came back; the caller wakes the agent with `machine_back_online`. Machine access
 *   paused meanwhile: the work waits for access instead, unpinned, which frees the machine, and
 *   its sessions there close (`policy_suspended`) as a suspension closes an active record's.
 * - **It stays away past the trigger's `waitingMachineHours`**
 *   (`requeueStrandedTicketWorkInTransaction`): the work is unpinned and queued again, as of
 *   when it started, so another machine of the pool can take it. Its sessions on the offline
 *   machine get close requests (`machine_reassigned`) that ride that machine's next heartbeat,
 *   and leave the record's live set, so the next machine starts a new one.
 */

type Waiting = {
  agentId: string
  executor: { lastSeenAt: Date | null; removedAt: Date | null; status: string } | null
  executorId: string | null
  id: string
  organizationId: string
  policy: { status: string } | null
  policyId: string | null
  sessionIds: string[]
  startedAt: Date
  stateReason: string | null
  status: string
  taskId: string
  triggerId: string | null
}

const WAITING_SELECT = {
  agentId: true, executorId: true, id: true, organizationId: true, policyId: true, sessionIds: true, startedAt: true,
  stateReason: true, status: true, taskId: true, triggerId: true,
  executor: { select: { lastSeenAt: true, removedAt: true, status: true } },
  policy: { select: { status: true } },
} as const

/** Whether a machine is heard from now: online, and a heartbeat inside the freshness window. */
export const ticketWorkMachineOnline = (
  executor: { lastSeenAt: Date | null; removedAt: Date | null; status: string } | null,
  now: Date,
): boolean => Boolean(executor && !executor.removedAt && executor.status === 'online'
  && executor.lastSeenAt && executor.lastSeenAt >= executorHeartbeatCutoff(now))

const loadWaiting = async (tx: Prisma.TransactionClient, workId: string): Promise<Waiting | null> => {
  const work = await tx.agentTicketWork.findUnique({ where: { id: workId }, select: WAITING_SELECT })
  return work && work.status === 'waiting_machine' && work.stateReason === 'machine_offline' && work.executorId
    ? work
    : null
}

export type TicketWorkMachineReturn = 'resumed' | 'access_paused' | 'still_offline' | 'not_waiting'

export const resumeTicketWorkOnItsMachineInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { now?: Date; workId: string },
): Promise<TicketWorkMachineReturn> => {
  const now = input.now ?? new Date()
  const work = await loadWaiting(tx, input.workId)
  if (!work) return 'not_waiting'
  if (!ticketWorkMachineOnline(work.executor, now)) return 'still_offline'
  if (work.policy?.status !== 'live') {
    await closeTicketWorkSessionsInTransaction(tx, [work], 'policy_suspended', null)
    await tx.agentTicketWork.update({
      where: { id: work.id }, data: { executorId: null, stateReason: 'machine_access_suspended' },
    })
    await syncTicketWorkClock(tx, work.id, now)
    await recordTicketWorkActivity(tx, {
      work, eventType: 'work_paused', status: 'waiting_machine', reason: 'machine_access_suspended',
      previousReason: 'machine_offline',
    })
    await enqueueTicketWorkSweep(tx, now)
    return 'access_paused'
  }
  await tx.agentTicketWork.update({ where: { id: work.id }, data: { stateReason: null, status: 'active' } })
  // Back at work on its machine: the hours clock runs again.
  await syncTicketWorkClock(tx, work.id, now)
  await recordTicketWorkActivity(tx, {
    work, eventType: 'work_resumed', status: 'active', reason: null, previousReason: 'machine_offline',
  })
  return 'resumed'
}

/** When the work began waiting: its newest `machine_offline` pause, never before its machine went quiet. */
const waitingSince = async (tx: Prisma.TransactionClient, work: Waiting): Promise<Date> => {
  const [paused] = await tx.$queryRaw<Array<{ created_at: Date }>>(Prisma.sql`
    SELECT created_at FROM task_events
    WHERE task_id = ${work.taskId}::uuid AND event_type = 'work_paused'
      AND payload->>'workId' = ${work.id} AND payload->>'reason' = 'machine_offline'
    ORDER BY created_at DESC LIMIT 1`)
  const quiet = work.executor?.lastSeenAt ?? work.startedAt
  return paused && paused.created_at > quiet ? paused.created_at : quiet
}

/** Returns whether the work was queued again for another machine. */
export const requeueStrandedTicketWorkInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { now?: Date; waitingMachineHours: number; workId: string },
): Promise<boolean> => {
  const now = input.now ?? new Date()
  const work = await loadWaiting(tx, input.workId)
  if (!work?.policyId || work.policy?.status !== 'live' || ticketWorkMachineOnline(work.executor, now)) return false
  const since = await waitingSince(tx, work)
  if (now.getTime() - since.getTime() < input.waitingMachineHours * 3_600_000) return false
  const strandedOn = work.executorId as string
  // Its sessions stay on the offline machine; they close when it reconnects, and the ticket's
  // next session starts on whichever machine takes the work.
  await closeTicketWorkSessionsInTransaction(tx, [work], 'machine_reassigned', null)
  for (const sessionId of work.sessionIds) {
    await tx.$executeRaw(Prisma.sql`
      UPDATE agent_ticket_work SET session_ids = array_remove(session_ids, ${sessionId}), updated_at = now()
      WHERE id = ${work.id}::uuid`)
  }
  await tx.agentTicketWork.update({ where: { id: work.id }, data: { executorId: null } })
  const reason = await standingPolicyPoolReason(tx, { now, policyId: work.policyId })
  const position = await queueTicketWorkInTransaction(tx, {
    joinedAt: work.startedAt, now, policyId: work.policyId, reason, workId: work.id,
  })
  await recordTicketWorkActivity(tx, {
    work, eventType: 'work_queued', status: 'queued', reason, previousReason: 'machine_offline',
  })
  await writeTicketWorkAudit(tx, {
    action: 'ticket.work.queued',
    metadata: {
      policyId: work.policyId, position, reason, requeuedFrom: strandedOn, taskId: work.taskId,
      triggerId: work.triggerId, waitingMachineHours: input.waitingMachineHours,
    },
    organizationId: work.organizationId,
    workId: work.id,
  })
  await enqueueTicketWorkSweep(tx, now)
  return true
}

/**
 * Whether a live policy still stands on what its author confirmed: the trigger digests to the
 * pinned terms, and every pool machine to its pinned descriptor digests. The dequeue asks it
 * before placing work; the suspension a drift calls for is the one the suspending doors write.
 */
export const standingPolicyDigestDrift = async (
  client: Prisma.TransactionClient | PrismaClient,
  policy: {
    executors: ReadonlyArray<{ descriptorConfigDigest: string; executorId: string; localPolicyDigest: string }>
    pinnedTerms: unknown
    trigger: { agentId: string | null; config: unknown; targetChannelId: string | null } | null
    triggerDigest: string
  },
): Promise<ExecutorStandingPolicySuspendedReason | null> => {
  const pinned = StandingPolicyPinnedTermsSchema.safeParse(policy.pinnedTerms)
  const terms = policy.trigger && pinned.success
    ? standingPolicyTermsOf(policy.trigger, standingPolicyLimitsOf(pinned.data))
    : null
  if (!terms || standingPolicyTermsDigest(terms) !== policy.triggerDigest) return 'trigger_changed'
  for (const row of policy.executors) {
    const digests = await standingPolicyMachineDigests(client, row.executorId)
    if (!digests || digests.descriptorConfigDigest !== row.descriptorConfigDigest
      || digests.localPolicyDigest !== row.localPolicyDigest) return 'descriptor_changed'
  }
  return null
}
