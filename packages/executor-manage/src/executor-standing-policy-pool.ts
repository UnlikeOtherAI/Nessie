import { Prisma } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import {
  StandingPolicyHostProfileSchema,
  TICKET_WORK_MACHINE_HOLDING_STATUSES,
  TICKET_WORK_SWEEP_TOPIC,
  ticketWorkCodingSessionContext,
  type TicketWorkStateReason,
} from '@nessie/schemas'

import { reportedExecutorCodingSessions } from './executor-coding-session-closes.js'
import { executorCodingSessionOwnerKey } from './executor-coding-session-owner.js'
import { executorHeartbeatCutoff } from './executor-liveness.js'
import { syncTicketWorkClock } from './ticket-work-clock.js'

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
 * Nothing free: the record is `queued`, with a position (ticket priority,
 * then `enqueuedAt`) and why — every machine busy, or every one offline. No
 * policy, or a suspended one: the record waits for machine access, pinned to
 * nothing. The caller writes the ticket's history rows and the one wake each
 * of these gets.
 */

export type TicketWorkMachinePlacement =
  | { kind: 'assigned'; executorId: string; policyId: string }
  | {
    kind: 'queued'
    policyId: string
    position: number
    reason: Extract<TicketWorkStateReason, 'queued_no_free_machine' | 'queued_machines_offline'>
    /** Pool machines held by other work, and pool machines offline: counts, never names. */
    busy: number
    offline: number
  }
  | {
    kind: 'waiting'
    policyId: string | null
    reason: Extract<TicketWorkStateReason, 'machine_access_not_set_up' | 'machine_access_suspended'>
  }

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

type MachineState = 'free' | 'busy' | 'offline'

const machineState = async (
  tx: Prisma.TransactionClient,
  input: { executorId: string; maxLiveSessions: number; now: Date; ownerKey: string; workId: string },
): Promise<MachineState> => {
  const executor = await tx.executor.findUnique({
    where: { id: input.executorId },
    select: { lastSeenAt: true, localMcp: true, removedAt: true, status: true },
  })
  if (!executor || executor.removedAt || executor.status !== 'online' || !executor.lastSeenAt
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
    select: { enqueuedAt: true, id: true, task: { select: { priority: true } } },
  })
  const order = queued.sort((left, right) => (
    (PRIORITY_RANK[left.task.priority] ?? 9) - (PRIORITY_RANK[right.task.priority] ?? 9)
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
    reason: Extract<TicketWorkStateReason, 'queued_no_free_machine' | 'queued_machines_offline'>
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
): Promise<Extract<TicketWorkStateReason, 'queued_no_free_machine' | 'queued_machines_offline'>> => {
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
    select: { agentId: true, executorId: true, id: true, taskId: true, triggerId: true },
  })
  const policy = work.triggerId
    ? await tx.executorStandingPolicy.findFirst({
        where: { status: { in: ['live', 'suspended'] }, triggerId: work.triggerId },
        select: { authorUserId: true, hostProfile: true, id: true, status: true },
      })
    : null
  if (!policy || policy.status !== 'live') {
    const reason = policy ? 'machine_access_suspended' as const : 'machine_access_not_set_up' as const
    await tx.agentTicketWork.update({
      where: { id: work.id },
      data: { executorId: null, policyId: policy?.id ?? null, stateReason: reason, status: 'waiting_machine' },
    })
    await syncTicketWorkClock(tx, work.id, now)
    return { kind: 'waiting', policyId: policy?.id ?? null, reason }
  }
  const pool = await lockStandingPolicyPool(tx, policy.id)
  const profile = StandingPolicyHostProfileSchema.safeParse(policy.hostProfile)
  const ownerFor = (executorId: string) => executorCodingSessionOwnerKey(executorId, {
    actorUserId: policy.authorUserId,
    agentId: work.agentId,
    contextId: ticketWorkCodingSessionContext(policy.id, work.taskId),
  })
  // A record coming back to work tries the machine it last worked on first:
  // its sessions are there.
  const ordered = [
    ...pool.filter((row) => row.executorId === work.executorId),
    ...pool.filter((row) => row.executorId !== work.executorId),
  ]
  let busy = 0
  let offline = 0
  for (const row of ordered) {
    const maxLiveSessions = profile.success
      ? profile.data.machines.find((machine) => machine.executorId === row.executorId)?.maxLiveSessionsPerOwner ?? 0
      : 0
    const state = await machineState(tx, {
      executorId: row.executorId, maxLiveSessions, now, ownerKey: ownerFor(row.executorId), workId: work.id,
    })
    if (state === 'free') {
      await tx.agentTicketWork.update({
        where: { id: work.id },
        data: {
          executorId: row.executorId, policyId: policy.id, queuePosition: null, stateReason: null, status: 'active',
        },
      })
      await syncTicketWorkClock(tx, work.id, now)
      return { executorId: row.executorId, kind: 'assigned', policyId: policy.id }
    }
    if (state === 'busy') busy += 1
    else offline += 1
  }
  const reason = busy === 0 ? 'queued_machines_offline' as const : 'queued_no_free_machine' as const
  const position = await queueTicketWorkInTransaction(tx, { now, policyId: policy.id, reason, workId: work.id })
  return { busy, kind: 'queued', offline, policyId: policy.id, position, reason }
}
