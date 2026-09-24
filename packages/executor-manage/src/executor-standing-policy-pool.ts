import { Prisma } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import {
  StandingPolicyHostProfileSchema,
  StandingPolicyPinnedTermsSchema,
  TICKET_WORK_MACHINE_HOLDING_STATUSES,
  TICKET_WORK_SWEEP_TOPIC,
  ticketWorkCodingSessionContext,
  type TicketWorkStateReason,
} from '@nessie/schemas'

import { reportedExecutorCodingSessions } from './executor-coding-session-closes.js'
import { executorCodingSessionOwnerKey } from './executor-coding-session-owner.js'
import { executorHeartbeatCutoff } from './executor-liveness.js'
import { syncTicketWorkClock } from './ticket-work-clock.js'
import { ticketWorkSessionOriginsOf } from './ticket-work-session-origins.js'

/**
 * The pool queue's assignment half, at dispatch
 * (docs/plans/2026-09-23-ticket-driven-agents/ticket-work.md → "The pool
 * queue (T4 assigns, T5 dequeues)"; docs/standards/ticket-work-machine-access.md).
 *
 * A record that needs a machine — a pickup, or a parked record a person moved
 * back — is placed in one transaction: the trigger's binding policy's pool
 * rows are locked (`FOR UPDATE`), then each pool machine under its own
 * advisory lock in id order (a machine can sit in two triggers' pools), and
 * the first machine that is online, held by no other record (active, or
 * waiting for it to reconnect — `agent_ticket_work_one_per_executor` holds
 * the same rule), and below its signed `maxLiveSessionsPerOwner` for this
 * ticket's own owner context takes it: `executorId` and `policyId` are
 * written and the record is `active`. Run setup only ever binds the machine
 * already pinned here.
 *
 * A record coming back to work — parked and moved back, or waiting for
 * machine access again — belongs on **its own** machine: the one it holds, or
 * the one its newest coding session was started on (`session_origins`),
 * while that machine is still in the pool. It takes that machine or queues
 * for it, ahead of new tickets, and moves to another only once its own is
 * gone from the pool or removed. Its own open sessions never make its own
 * machine busy.
 *
 * The policy spent its `dailyUsd` today: nothing is assigned, and the record
 * is queued with `queued_daily_limit` until the UTC day turns — the limit
 * fails only work that is running (`enforceTicketWorkLimitsInTransaction`).
 *
 * Nothing free: the record is `queued`, with a position (its own machine
 * first, then ticket priority, then `enqueuedAt`) and why — every machine
 * busy, or every one offline. No policy, or a suspended one: the record waits
 * for machine access, pinned to nothing. The caller writes the ticket's
 * history rows and the one wake each of these gets.
 */

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

type QueueReason = Extract<TicketWorkStateReason, 'queued_no_free_machine' | 'queued_machines_offline'
  | 'queued_daily_limit'>

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 }

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
 * that may free a machine enqueues it with a short idempotency window. Nothing
 * subscribes to it until the sweep lands (T3), and the dequeue is T5's.
 */
export const enqueueTicketWorkSweep = async (
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  now = new Date(),
): Promise<void> => {
  const bucket = String(Math.floor(now.getTime() / 10_000))
  await enqueueQueueJob(tx, {
    idempotencyKey: `${TICKET_WORK_SWEEP_TOPIC}:${bucket}`,
    payload: { bucket },
    topic: TICKET_WORK_SWEEP_TOPIC,
  })
}

type MachineState = 'free' | 'busy' | 'offline' | 'gone'

const machineState = async (
  tx: Prisma.TransactionClient,
  input: { executorId: string; maxLiveSessions: number; now: Date; ownerKey: string; workId: string },
): Promise<MachineState> => {
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
  if (held > 0) return 'busy'
  const live = reportedExecutorCodingSessions(executor.localMcp)
    .filter((session) => session.ownerKey === input.ownerKey && session.status !== 'closed').length
  return live < input.maxLiveSessions ? 'free' : 'busy'
}

/** Where a queued record stands among its policy's queue: priority, then age. */
export const ticketWorkQueuePosition = async (
  tx: Prisma.TransactionClient,
  input: { policyId: string; workId: string },
): Promise<number> => {
  const queued = await tx.agentTicketWork.findMany({
    where: { policyId: input.policyId, status: 'queued' },
    select: {
      enqueuedAt: true, executorId: true, id: true, sessionOrigins: true, task: { select: { priority: true } },
    },
  })
  const pool = new Set((await tx.executorStandingPolicyExecutor.findMany({
    where: { policyId: input.policyId }, select: { executorId: true },
  })).map((row) => row.executorId))
  const returning = (entry: (typeof queued)[number]): number => (homeMachineOf(entry, pool) ? 0 : 1)
  const order = queued.sort((left, right) => (
    returning(left) - returning(right)
    || (PRIORITY_RANK[left.task.priority] ?? 9) - (PRIORITY_RANK[right.task.priority] ?? 9)
    || (left.enqueuedAt?.getTime() ?? 0) - (right.enqueuedAt?.getTime() ?? 0)
    || left.id.localeCompare(right.id)
  ))
  const index = order.findIndex((entry) => entry.id === input.workId)
  return index < 0 ? order.length + 1 : index + 1
}

/**
 * Queue one record under a policy: its reason, its place, and every queued
 * record of the policy renumbered. Read the pool first: all offline is its
 * own reason, which the chip says.
 */
export const queueTicketWorkInTransaction = async (
  tx: Prisma.TransactionClient,
  input: {
    policyId: string
    reason: QueueReason
    workId: string
    now?: Date
  },
): Promise<number> => {
  const now = input.now ?? new Date()
  const current = await tx.agentTicketWork.findUniqueOrThrow({
    where: { id: input.workId }, select: { enqueuedAt: true },
  })
  await tx.agentTicketWork.update({
    where: { id: input.workId },
    data: {
      enqueuedAt: current.enqueuedAt ?? now,
      policyId: input.policyId,
      stateReason: input.reason,
      status: 'queued',
    },
  })
  // Queued work waits for a machine: its hours clock pauses.
  await syncTicketWorkClock(tx, input.workId, now)
  const queued = await tx.agentTicketWork.findMany({
    where: { policyId: input.policyId, status: 'queued' }, select: { id: true },
  })
  let position = 0
  for (const entry of queued) {
    const at = await ticketWorkQueuePosition(tx, { policyId: input.policyId, workId: entry.id })
    await tx.agentTicketWork.update({ where: { id: entry.id }, data: { queuePosition: at } })
    if (entry.id === input.workId) position = at
  }
  return position
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

export const placeTicketWorkOnMachineInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { workId: string; now?: Date },
): Promise<TicketWorkMachinePlacement> => {
  const now = input.now ?? new Date()
  const work = await tx.agentTicketWork.findUniqueOrThrow({
    where: { id: input.workId },
    select: { agentId: true, executorId: true, id: true, sessionOrigins: true, taskId: true, triggerId: true },
  })
  const policy = work.triggerId
    ? await tx.executorStandingPolicy.findFirst({
        where: { status: { in: ['live', 'suspended'] }, triggerId: work.triggerId },
        select: { authorUserId: true, hostProfile: true, id: true, pinnedTerms: true, status: true },
      })
    : null
  // No policy, or a suspended one: the work waits for machine access, pinned to nothing.
  const waitForAccess = async (suspendedPolicyId: string | null): Promise<TicketWorkMachinePlacement> => {
    const reason = suspendedPolicyId ? 'machine_access_suspended' as const : 'machine_access_not_set_up' as const
    await tx.agentTicketWork.update({
      where: { id: work.id },
      data: { executorId: null, policyId: suspendedPolicyId, stateReason: reason, status: 'waiting_machine' },
    })
    await syncTicketWorkClock(tx, work.id, now)
    return { kind: 'waiting', policyId: suspendedPolicyId, reason }
  }
  if (!policy || policy.status !== 'live') return waitForAccess(policy?.id ?? null)
  const pool = await lockStandingPolicyPool(tx, policy.id)
  // Suspended or ended while this waited for the pool: nothing is placed under it.
  const current = await tx.executorStandingPolicy.findUnique({ where: { id: policy.id }, select: { status: true } })
  if (current?.status !== 'live') return waitForAccess(current?.status === 'suspended' ? policy.id : null)
  const profile = StandingPolicyHostProfileSchema.safeParse(policy.hostProfile)
  const ownerFor = (executorId: string) => executorCodingSessionOwnerKey(executorId, {
    actorUserId: policy.authorUserId,
    agentId: work.agentId,
    contextId: ticketWorkCodingSessionContext(policy.id, work.taskId),
  })
  const queue = async (reason: QueueReason, counts: { busy: number; offline: number }) => ({
    ...counts, kind: 'queued' as const, policyId: policy.id, reason,
    position: await queueTicketWorkInTransaction(tx, { now, policyId: policy.id, reason, workId: work.id }),
  })
  if (await dailySpendUsedUp(tx, { now, pinnedTerms: policy.pinnedTerms, policyId: policy.id })) {
    return queue('queued_daily_limit', { busy: 0, offline: 0 })
  }
  const assign = async (executorId: string): Promise<TicketWorkMachinePlacement> => {
    await tx.agentTicketWork.update({
      where: { id: work.id },
      data: { executorId, policyId: policy.id, queuePosition: null, stateReason: null, status: 'active' },
    })
    await syncTicketWorkClock(tx, work.id, now)
    return { executorId, kind: 'assigned', policyId: policy.id }
  }
  const home = homeMachineOf(work, new Set(pool.map((row) => row.executorId)))
  if (home) {
    // Its own open sessions are its own to continue: they never make its machine busy.
    const state = await machineState(tx, {
      executorId: home, maxLiveSessions: Number.POSITIVE_INFINITY, now, ownerKey: ownerFor(home), workId: work.id,
    })
    if (state === 'free') return assign(home)
    if (state === 'busy') return queue('queued_no_free_machine', { busy: 1, offline: 0 })
    if (state === 'offline') return queue('queued_machines_offline', { busy: 0, offline: 1 })
  }
  let busy = 0
  let offline = 0
  for (const row of pool.filter((entry) => entry.executorId !== home)) {
    const maxLiveSessions = profile.success
      ? profile.data.machines.find((machine) => machine.executorId === row.executorId)?.maxLiveSessionsPerOwner ?? 0
      : 0
    const state = await machineState(tx, {
      executorId: row.executorId, maxLiveSessions, now, ownerKey: ownerFor(row.executorId), workId: work.id,
    })
    if (state === 'free') return assign(row.executorId)
    if (state === 'busy') busy += 1
    else offline += 1
  }
  return queue(busy === 0 ? 'queued_machines_offline' : 'queued_no_free_machine', { busy, offline })
}

/**
 * The machine a record belongs on when it comes back to work: the one it
 * holds, else the one its newest coding session was started on, while that
 * machine is in the pool. Null for a record with no machine of its own.
 */
export const homeMachineOf = (
  work: { executorId: string | null; sessionOrigins: unknown },
  pool: ReadonlySet<string>,
): string | null => {
  if (work.executorId && pool.has(work.executorId)) return work.executorId
  const newest = Object.values(ticketWorkSessionOriginsOf(work.sessionOrigins))
    .filter((origin) => pool.has(origin.executorId))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0]
  return newest?.executorId ?? null
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
