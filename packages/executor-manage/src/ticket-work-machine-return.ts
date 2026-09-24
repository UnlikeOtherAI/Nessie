import { Prisma, type PrismaClient } from '@prisma/client'
import { StandingPolicyPinnedTermsSchema, type ExecutorStandingPolicySuspendedReason } from '@nessie/schemas'

import { executorHeartbeatCutoff } from './executor-liveness.js'
import { standingPolicyMachineRevision } from './executor-standing-policy-machines.js'
import {
  enqueueTicketWorkSweep,
  queueTicketWorkInTransaction,
  standingPolicyPoolReason,
} from './executor-standing-policy-pool.js'
import { standingPolicyLimitsOf, standingPolicyTermsDigest, standingPolicyTermsOf } from './executor-standing-policy-terms.js'
import { syncTicketWorkClock } from './ticket-work-clock.js'
import { recordTicketWorkActivity, writeTicketWorkAudit } from './ticket-work-records.js'
import { releaseTicketWorkSessionsInTransaction } from './ticket-work-session-release.js'

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
 *   its sessions there close (`policy_suspended`) and leave its live set, as a suspension's do.
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

/**
 * Take waiting work off the machine it holds and queue it under its policy,
 * as of when it started. Its sessions stay on that machine; they close when it
 * reconnects (`machine_reassigned`), and the ticket's next session starts on
 * whichever machine takes the work.
 */
const moveTicketWorkOffItsMachine = async (
  tx: Prisma.TransactionClient,
  work: Waiting,
  input: { now: Date; waitingMachineHours?: number },
): Promise<void> => {
  const policyId = work.policyId as string
  const movedFrom = work.executorId as string
  await releaseTicketWorkSessionsInTransaction(tx, [work], 'machine_reassigned', null)
  await tx.agentTicketWork.update({ where: { id: work.id }, data: { executorId: null } })
  const reason = await standingPolicyPoolReason(tx, { now: input.now, policyId })
  const position = await queueTicketWorkInTransaction(tx, {
    joinedAt: work.startedAt, now: input.now, policyId, reason, workId: work.id,
  })
  await recordTicketWorkActivity(tx, {
    work, eventType: 'work_queued', status: 'queued', reason, previousReason: 'machine_offline',
  })
  await writeTicketWorkAudit(tx, {
    action: 'ticket.work.queued',
    metadata: {
      policyId, position, reason, requeuedFrom: movedFrom, taskId: work.taskId, triggerId: work.triggerId,
      ...(input.waitingMachineHours === undefined ? {} : { waitingMachineHours: input.waitingMachineHours }),
    },
    organizationId: work.organizationId,
    workId: work.id,
  })
  await enqueueTicketWorkSweep(tx, input.now)
}

export type TicketWorkMachineReturn = 'resumed' | 'access_paused' | 'requeued' | 'still_offline' | 'not_waiting'

export const resumeTicketWorkOnItsMachineInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { now?: Date; workId: string },
): Promise<TicketWorkMachineReturn> => {
  const now = input.now ?? new Date()
  const work = await loadWaiting(tx, input.workId)
  if (!work) return 'not_waiting'
  if (!ticketWorkMachineOnline(work.executor, now)) return 'still_offline'
  // Handed to a policy whose pool does not name this machine: it was never
  // the new policy's to bind, so the work queues for one that is.
  if (work.policy?.status === 'live' && work.policyId && await tx.executorStandingPolicyExecutor.count({
    where: { executorId: work.executorId as string, policyId: work.policyId },
  }) === 0) {
    await moveTicketWorkOffItsMachine(tx, work, { now })
    return 'requeued'
  }
  if (work.policy?.status !== 'live') {
    await releaseTicketWorkSessionsInTransaction(tx, [work], 'policy_suspended', null)
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
  if (!work?.policyId || work.policy?.status !== 'live' || ticketWorkMachineOnline(work.executor, now)) {
    return false
  }
  const since = await waitingSince(tx, work)
  if (now.getTime() - since.getTime() < input.waitingMachineHours * 3_600_000) return false
  await moveTicketWorkOffItsMachine(tx, work, { now, waitingMachineHours: input.waitingMachineHours })
  return true
}

/**
 * Whether a live policy still stands on what its author confirmed (T5): the trigger digests to
 * the pinned terms, and every pool machine whose latest revision is active to its pinned
 * descriptor digests. A drift is `suspend`, the reason the suspending doors write. A machine
 * whose latest revision awaits review, or was disabled, is `unplaceable`: its review settles
 * the policy, so the dequeue only leaves the machine alone until then.
 */
export type StandingPolicyDigestCheck = {
  suspend: ExecutorStandingPolicySuspendedReason | null
  unplaceable: ReadonlySet<string>
}

export const standingPolicyDigestCheck = async (
  client: Prisma.TransactionClient | PrismaClient,
  policy: {
    executors: ReadonlyArray<{ descriptorConfigDigest: string; executorId: string; localPolicyDigest: string }>
    pinnedTerms: unknown
    trigger: { agentId: string | null; config: unknown; targetChannelId: string | null } | null
    triggerDigest: string
  },
): Promise<StandingPolicyDigestCheck> => {
  const unplaceable = new Set<string>()
  const pinned = StandingPolicyPinnedTermsSchema.safeParse(policy.pinnedTerms)
  const terms = policy.trigger && pinned.success
    ? standingPolicyTermsOf(policy.trigger, standingPolicyLimitsOf(pinned.data))
    : null
  if (!terms || standingPolicyTermsDigest(terms) !== policy.triggerDigest) return { suspend: 'trigger_changed', unplaceable }
  for (const row of policy.executors) {
    const revision = await standingPolicyMachineRevision(client, row.executorId)
    if (revision.kind === 'unreviewed') {
      unplaceable.add(row.executorId)
      continue
    }
    const { digests } = revision
    if (!digests || digests.descriptorConfigDigest !== row.descriptorConfigDigest
      || digests.localPolicyDigest !== row.localPolicyDigest) return { suspend: 'descriptor_changed', unplaceable }
  }
  return { suspend: null, unplaceable }
}
