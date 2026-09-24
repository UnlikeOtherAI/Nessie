import { Prisma } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import {
  StandingPolicyHostProfileSchema,
  StandingPolicyPinnedTermsSchema,
  TICKET_WORK_MACHINE_HOLDING_STATUSES,
  TICKET_WORK_SWEEP_TOPIC,
  ticketWorkCodingSessionContext,
  type ExecutorCodingSessionCloseReason,
  type TicketWorkStateReason,
  type TicketWorkSweepJobPayload,
} from '@nessie/schemas'

import { reportedExecutorCodingSessions } from './executor-coding-session-closes.js'
import { executorCodingSessionOwnerKey } from './executor-coding-session-owner.js'
import { executorHeartbeatCutoff } from './executor-liveness.js'
import {
  queuedTicketWorkOutranks,
  renumberTicketWorkQueueInTransaction,
} from './executor-standing-policy-queue.js'
import { syncTicketWorkClock } from './ticket-work-clock.js'
import { homeMachineOf, ticketWorkSessionOriginsOf } from './ticket-work-session-origins.js'
import { releaseTicketWorkSessionsInTransaction } from './ticket-work-session-release.js'

/**
 * The pool queue's assignment half, at dispatch
 * (docs/plans/2026-09-23-ticket-driven-agents/ticket-work.md → "The pool
 * queue (T4 assigns, T5 dequeues)"; docs/standards/ticket-work-machine-access.md).
 *
 * A record that needs a machine — a pickup, or a parked record a person moved
 * back — is placed in one transaction: the trigger's binding policy's own row
 * is read under a shared lock (a suspension or an end waits for the placement
 * that read it live), its pool rows are locked (`FOR UPDATE`), then each pool
 * machine under its own advisory lock in id order (a machine can sit in two
 * triggers' pools), and the first machine that is online, held by no other
 * record (active, or waiting for it to reconnect —
 * `agent_ticket_work_one_per_executor` holds the same rule), and below its
 * signed `maxLiveSessionsPerOwner` for this ticket's own owner context takes
 * it: `executorId` and `policyId` are written and the record is `active`. Run
 * setup only ever binds the machine already pinned here.
 *
 * **One rule for the machine a record last worked on** (`homeMachineOf`: the
 * one it holds, else the one its newest coding session was started on, while
 * that machine is in the pool). The record tries it first, and its own
 * sessions there never count against its quota. It waits for it only while it
 * could take the record back — online and held by no other work (the dequeue
 * also leaves alone a machine whose newest revision awaits review; a placement
 * leaves that to the binder, as it does for every machine); otherwise the
 * record takes any free machine of its pool rather than starve, and the
 * sessions it leaves behind are closed there (`machine_reassigned`) and
 * forgotten. The dequeue follows the same rule.
 *
 * The policy spent its `dailyUsd` today: nothing is assigned, and the record
 * is queued with `queued_daily_limit` until the UTC day turns — the limit
 * fails only work that is running (`enforceTicketWorkLimitsInTransaction`).
 *
 * Nothing free: the record is `queued`, with a position (ticket priority, then
 * `enqueuedAt`) and why — every machine busy, or every one offline. No policy,
 * or a suspended one: the record waits for machine access, pinned to nothing,
 * its sessions closed. The caller writes the ticket's history rows and the one
 * wake each of these gets.
 */

type QueueReason = Extract<TicketWorkStateReason, 'queued_no_free_machine' | 'queued_machines_offline'
  | 'queued_daily_limit'>

export type TicketWorkMachinePlacement =
  | { kind: 'assigned'; executorId: string; policyId: string }
  | {
    kind: 'queued'
    policyId: string
    position: number
    reason: QueueReason
    /** Pool machines held by other work, and pool machines offline: counts, never names. */
    busy: number
    offline: number
  }
  | {
    kind: 'waiting'
    policyId: string | null
    reason: Extract<TicketWorkStateReason, 'machine_access_not_set_up' | 'machine_access_suspended'>
  }

/** Lock one policy's pool, then each of its machines, always in the same order. */
export const lockStandingPolicyPool = async (
  tx: Prisma.TransactionClient,
  policyId: string,
): Promise<Array<{ executorId: string; position: number }>> => {
  const rows = await tx.$queryRaw<Array<{ executor_id: string; position: number }>>(Prisma.sql`
    SELECT executor_id, position FROM executor_standing_policy_executors
    WHERE policy_id = ${policyId}::uuid
    ORDER BY position
    FOR UPDATE`)
  for (const executorId of rows.map((row) => row.executor_id).sort()) {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ticket-work-machine:${executorId}`}, 0))`)
  }
  return rows.map((row) => ({ executorId: row.executor_id, position: row.position }))
}

/**
 * The dispatcher, one idempotent job (`ticket-work.sweep`): every transaction
 * that may free a machine enqueues it with a short idempotency window, and the
 * sweep's dequeue takes it from there (T5). Such an enqueue runs the machine
 * steps alone (`machinesOnly`): the quiet wakes, lost jobs and the UOA re-check
 * of every author are the periodic tick's, so a busy minute never multiplies
 * them.
 */
export const enqueueTicketWorkSweep = async (
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  now = new Date(),
): Promise<void> => {
  const bucket = String(Math.floor(now.getTime() / 10_000))
  const payload: TicketWorkSweepJobPayload = { bucket, machinesOnly: true }
  await enqueueQueueJob(tx, {
    idempotencyKey: `${TICKET_WORK_SWEEP_TOPIC}:machines:${bucket}`,
    payload,
    topic: TICKET_WORK_SWEEP_TOPIC,
  })
}

/**
 * The policy's own row, shared, before anything reads whether it is live (T5):
 * a suspension or an end waits for the placement that saw it live, so a record
 * is never made `active` under a policy that stopped binding. The ticket's own
 * lock is `FOR NO KEY UPDATE` (`lockTicketForWork`), which the history rows an
 * end writes never wait on, so this may be taken after it without a cycle.
 */
export const lockStandingPolicyRow = async (
  tx: Prisma.TransactionClient,
  policyId: string,
): Promise<string | null> => {
  const [row] = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
    SELECT status FROM executor_standing_policies WHERE id = ${policyId}::uuid FOR SHARE`)
  return row?.status ?? null
}

/**
 * Every policy a wake of this record may read, shared, in id order, before the
 * wake writes anything: the one the record is under and the trigger's current
 * one. The caller holds the ticket's lock and the thread's run slot.
 */
export const lockTicketWorkPoliciesInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { policyId: string | null; triggerId: string | null },
): Promise<void> => {
  const current = input.triggerId
    ? await tx.executorStandingPolicy.findMany({
        where: { status: { in: ['live', 'suspended'] }, triggerId: input.triggerId }, select: { id: true },
      })
    : []
  const ids = [...new Set([...(input.policyId ? [input.policyId] : []), ...current.map((row) => row.id)])].sort()
  for (const id of ids) await lockStandingPolicyRow(tx, id)
}

/**
 * How one pool machine stands for one record: `gone` (removed or revoked),
 * `offline`, `held` by another record's work (active on it, or waiting for it
 * to reconnect), at this ticket's own session `quota`, or `free`. A quota is
 * this ticket's alone, counted as the bridge counts it (a session is live until
 * it is closed or failed), and never keeps a record from the machine it last
 * worked on — those sessions are its own.
 */
export type TicketWorkMachineState = 'free' | 'held' | 'quota' | 'offline' | 'gone'

const machineState = async (
  tx: Prisma.TransactionClient,
  input: { executorId: string; maxLiveSessions: number; now: Date; own: boolean; ownerKey: string; workId: string },
): Promise<TicketWorkMachineState> => {
  const executor = await tx.executor.findUnique({
    where: { id: input.executorId },
    select: { lastSeenAt: true, localMcp: true, removedAt: true, status: true },
  })
  if (!executor || executor.removedAt || executor.status === 'revoked') return 'gone'
  if (executor.status !== 'online' || !executor.lastSeenAt
    || executor.lastSeenAt < executorHeartbeatCutoff(input.now)) return 'offline'
  const held = await tx.agentTicketWork.count({
    where: {
      executorId: input.executorId,
      id: { not: input.workId },
      status: { in: [...TICKET_WORK_MACHINE_HOLDING_STATUSES] },
    },
  })
  if (held > 0) return 'held'
  if (input.own) return 'free'
  const live = reportedExecutorCodingSessions(executor.localMcp)
    .filter((session) => session.ownerKey === input.ownerKey && session.status !== 'closed' && session.status !== 'failed')
    .length
  return live < input.maxLiveSessions ? 'free' : 'quota'
}

/**
 * Queue one record under a policy: its reason, its place, and every queued
 * record of the policy renumbered. Read the pool first: all offline is its
 * own reason, which the chip says. A record joins the queue at the moment it
 * first did (`enqueuedAt`), or at `joinedAt` when the caller names an earlier
 * one — work taken off a machine that stayed away joins as of its start, ahead
 * of tickets that never began.
 */
export const queueTicketWorkInTransaction = async (
  tx: Prisma.TransactionClient,
  input: {
    policyId: string
    reason: QueueReason
    workId: string
    now?: Date
    joinedAt?: Date
  },
): Promise<number> => {
  const now = input.now ?? new Date()
  const current = await tx.agentTicketWork.findUniqueOrThrow({
    where: { id: input.workId }, select: { enqueuedAt: true },
  })
  await tx.agentTicketWork.update({
    where: { id: input.workId },
    data: {
      enqueuedAt: current.enqueuedAt ?? input.joinedAt ?? now,
      policyId: input.policyId,
      stateReason: input.reason,
      status: 'queued',
    },
  })
  // Queued work waits for a machine: its hours clock pauses.
  await syncTicketWorkClock(tx, input.workId, now)
  const places = await renumberTicketWorkQueueInTransaction(tx, input.policyId)
  return places.get(input.workId) ?? 0
}

/** How a policy's pool stands right now, for a record the caller is queueing. */
export const standingPolicyPoolReason = async (
  tx: Prisma.TransactionClient,
  input: { policyId: string; now?: Date },
): Promise<Exclude<QueueReason, 'queued_daily_limit'>> => {
  const now = input.now ?? new Date()
  const pool = await tx.executorStandingPolicyExecutor.findMany({
    where: { policyId: input.policyId },
    select: { executor: { select: { lastSeenAt: true, removedAt: true, status: true } } },
  })
  const online = pool.some(({ executor }) => !executor.removedAt && executor.status === 'online'
    && executor.lastSeenAt !== null && executor.lastSeenAt >= executorHeartbeatCutoff(now))
  return online ? 'queued_no_free_machine' : 'queued_machines_offline'
}

type PlacingPolicy = { authorUserId: string; hostProfile: unknown; id: string; pinnedTerms: unknown }
type PlacedWork = {
  agentId: string
  executorId: string | null
  id: string
  sessionOrigins: unknown
  taskId: string
}

export const placeTicketWorkOnMachineInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { workId: string; now?: Date },
): Promise<TicketWorkMachinePlacement> => {
  const now = input.now ?? new Date()
  const work = await tx.agentTicketWork.findUniqueOrThrow({
    where: { id: input.workId },
    select: {
      agentId: true, enqueuedAt: true, executorId: true, id: true, sessionOrigins: true, taskId: true, triggerId: true,
      task: { select: { priority: true } },
    },
  })
  const policy = work.triggerId
    ? await tx.executorStandingPolicy.findFirst({
        where: { status: { in: ['live', 'suspended'] }, triggerId: work.triggerId },
        select: { authorUserId: true, hostProfile: true, id: true, pinnedTerms: true },
      })
    : null
  // No policy, or a suspended one: the work waits for machine access, pinned to nothing.
  const waitForAccess = async (suspendedPolicyId: string | null): Promise<TicketWorkMachinePlacement> => {
    const reason = suspendedPolicyId ? 'machine_access_suspended' as const : 'machine_access_not_set_up' as const
    // Unpinned: what it left on its last machine closes there.
    await releaseMachineSessions(tx, {
      executorId: null, reason: suspendedPolicyId ? 'policy_suspended' : 'policy_ended', workId: work.id,
    })
    await tx.agentTicketWork.update({
      where: { id: work.id },
      data: { executorId: null, policyId: suspendedPolicyId, stateReason: reason, status: 'waiting_machine' },
    })
    await syncTicketWorkClock(tx, work.id, now)
    return { kind: 'waiting', policyId: suspendedPolicyId, reason }
  }
  if (!policy) return waitForAccess(null)
  // Read live under the policy row's shared lock: a suspension or an end in flight is read, never raced.
  const status = await lockStandingPolicyRow(tx, policy.id)
  if (status !== 'live') return waitForAccess(status === 'suspended' ? policy.id : null)
  const pool = await lockStandingPolicyPool(tx, policy.id)
  const queue = async (reason: QueueReason, counts: { busy: number; offline: number }) => ({
    ...counts, kind: 'queued' as const, policyId: policy.id, reason,
    position: await queueTicketWorkInTransaction(tx, { now, policyId: policy.id, reason, workId: work.id }),
  })
  if (await dailySpendUsedUp(tx, { now, pinnedTerms: policy.pinnedTerms, policyId: policy.id })) {
    return queue('queued_daily_limit', { busy: 0, offline: 0 })
  }
  const home = homeMachineOf(work, new Set(pool.map((row) => row.executorId)))
  // Its own machine first, then the pool's order.
  const ordered = [
    ...pool.filter((row) => row.executorId === home),
    ...pool.filter((row) => row.executorId !== home),
  ]
  let busy = 0
  let offline = 0
  let reserved = false
  // Where this record would stand in the line, had it joined it now (T5).
  const entry = { enqueuedAt: work.enqueuedAt ?? now, id: work.id, priority: work.task.priority }
  for (const row of ordered) {
    const own = row.executorId === home
    const state = await machineStateFor(tx, { executorId: row.executorId, now, own, policy, work })
    // A free machine that is not this record's own goes to queued work ahead of it first.
    const taken = state === 'free' && !own
      && await queuedTicketWorkOutranks(tx, { executorId: row.executorId, now, record: entry })
    if (state === 'free' && !taken) {
      await assignTicketWork(tx, { executorId: row.executorId, now, policyId: policy.id, workId: work.id })
      return { executorId: row.executorId, kind: 'assigned', policyId: policy.id }
    }
    reserved ||= taken
    if (state === 'offline' || state === 'gone') offline += 1
    else busy += 1
  }
  const reason = busy === 0 ? 'queued_machines_offline' as const : 'queued_no_free_machine' as const
  const placed = await queue(reason, { busy, offline })
  // A free machine left to the queue: the dispatcher places whoever is first on it.
  if (reserved) await enqueueTicketWorkSweep(tx, now)
  return placed
}

/** One pool machine for this record, by its pinned quota for the ticket's own owner key. */
const machineStateFor = (
  tx: Prisma.TransactionClient,
  input: { executorId: string; now: Date; own: boolean; policy: Omit<PlacingPolicy, 'pinnedTerms'>; work: PlacedWork },
): Promise<TicketWorkMachineState> => {
  const profile = StandingPolicyHostProfileSchema.safeParse(input.policy.hostProfile)
  const maxLiveSessions = profile.success
    ? profile.data.machines.find((machine) => machine.executorId === input.executorId)?.maxLiveSessionsPerOwner ?? 0
    : 0
  const ownerKey = executorCodingSessionOwnerKey(input.executorId, {
    actorUserId: input.policy.authorUserId,
    agentId: input.work.agentId,
    contextId: ticketWorkCodingSessionContext(input.policy.id, input.work.taskId),
  })
  return machineState(tx, {
    executorId: input.executorId, maxLiveSessions, now: input.now, own: input.own, ownerKey, workId: input.work.id,
  })
}

/**
 * A record leaving the machine its sessions run on — unpinned (`executorId: null`), or pinned to
 * another (`machine_reassigned`) — closes the sessions it has on any other machine than the one it
 * goes to, each on its own machine (`session_origins`), and forgets them (T5).
 */
const releaseMachineSessions = async (
  tx: Prisma.TransactionClient,
  input: { executorId: string | null; reason?: ExecutorCodingSessionCloseReason; workId: string },
): Promise<void> => {
  const record = await tx.agentTicketWork.findUniqueOrThrow({
    where: { id: input.workId },
    select: {
      agentId: true, executorId: true, id: true, policyId: true, sessionIds: true, sessionOrigins: true, taskId: true,
    },
  })
  const origins = ticketWorkSessionOriginsOf(record.sessionOrigins)
  const leaving = record.sessionIds.filter((sessionId) => (
    (origins[sessionId]?.executorId ?? record.executorId) !== input.executorId))
  if (leaving.length === 0) return
  await releaseTicketWorkSessionsInTransaction(tx, [{ ...record, sessionIds: leaving }],
    input.reason ?? 'machine_reassigned', null)
}

/** Pin the record to the machine, `active`, its hours clock running, and its policy's queue renumbered. */
const assignTicketWork = async (
  tx: Prisma.TransactionClient,
  input: { executorId: string; now: Date; policyId: string; workId: string },
): Promise<void> => {
  await releaseMachineSessions(tx, { executorId: input.executorId, workId: input.workId })
  await tx.agentTicketWork.update({
    where: { id: input.workId },
    data: {
      executorId: input.executorId, policyId: input.policyId, queuePosition: null, stateReason: null, status: 'active',
    },
  })
  await syncTicketWorkClock(tx, input.workId, input.now)
  await renumberTicketWorkQueueInTransaction(tx, input.policyId)
}

/** Whether the policy already spent its `dailyUsd` this UTC day. */
const dailySpendUsedUp = async (
  tx: Prisma.TransactionClient,
  input: { now: Date; pinnedTerms: unknown; policyId: string },
): Promise<boolean> => {
  const terms = StandingPolicyPinnedTermsSchema.safeParse(input.pinnedTerms)
  if (!terms.success) return false
  const day = new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), input.now.getUTCDate()))
  const spent = await tx.executorStandingPolicyDailySpend.findUnique({
    where: { policyId_day: { day, policyId: input.policyId } },
    select: { costUsd: true },
  })
  return Number(spent?.costUsd ?? 0) >= terms.data.limits.dailyUsd
}

/**
 * The dequeue's placement (T5): one queued record onto one named machine of
 * its live policy's pool, under the pool's locks, or nothing at all. The
 * dispatcher chose the machine and the record; this says whether the machine
 * is still free for it — `held`, `offline` or `gone` for everyone, `quota` for
 * this ticket alone, `daily_limit` for the policy's whole queue today — and
 * pins it when it is.
 */
export const placeTicketWorkOnExecutorInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { executorId: string; now?: Date; workId: string },
): Promise<TicketWorkMachineState | 'daily_limit' | 'not_live'> => {
  const now = input.now ?? new Date()
  const work = await tx.agentTicketWork.findUniqueOrThrow({
    where: { id: input.workId },
    select: { agentId: true, executorId: true, id: true, policyId: true, sessionOrigins: true, status: true, taskId: true },
  })
  // Read live under its row's shared lock, which the dequeue took first.
  if (!work.policyId || work.status !== 'queued' || await lockStandingPolicyRow(tx, work.policyId) !== 'live') {
    return 'not_live'
  }
  const policy = await tx.executorStandingPolicy.findUniqueOrThrow({
    where: { id: work.policyId }, select: { authorUserId: true, hostProfile: true, id: true, pinnedTerms: true },
  })
  const pool = await lockStandingPolicyPool(tx, policy.id)
  if (!pool.some((row) => row.executorId === input.executorId)) return 'not_live'
  if (await dailySpendUsedUp(tx, { now, pinnedTerms: policy.pinnedTerms, policyId: policy.id })) {
    // The day is spent: the record waits for it to turn, saying so.
    await tx.agentTicketWork.update({ where: { id: work.id }, data: { stateReason: 'queued_daily_limit' } })
    return 'daily_limit'
  }
  const own = input.executorId === homeMachineOf(work, new Set(pool.map((row) => row.executorId)))
  const state = await machineStateFor(tx, { executorId: input.executorId, now, own, policy, work })
  if (state === 'free') await assignTicketWork(tx, { executorId: input.executorId, now, policyId: policy.id, workId: work.id })
  return state
}
