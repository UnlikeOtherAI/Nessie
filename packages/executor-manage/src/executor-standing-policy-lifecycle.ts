import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { writeAuditEntryInTransaction } from '@nessie/db'
import {
  TICKET_WORK_LIVE_STATUSES,
  ticketWorkCodingSessionContext,
  type ExecutorCodingSessionCloseReason,
  type ExecutorStandingPolicyEndedReason,
  type ExecutorStandingPolicySuspendedReason,
} from '@nessie/schemas'

import { requestExecutorCodingSessionCloseForSessionsInTransaction } from './executor-coding-session-closes.js'
import {
  enqueueTicketWorkSweep,
  queueTicketWorkInTransaction,
  standingPolicyPoolReason,
} from './executor-standing-policy-pool.js'
import { renumberTicketWorkQueueInTransaction } from './executor-standing-policy-queue.js'
import { syncTicketWorkClock } from './ticket-work-clock.js'
import { endTicketWork, recordTicketWorkActivity, writeTicketWorkAudit } from './ticket-work-records.js'

/**
 * A standing policy's transitions after it was confirmed, each in the
 * transaction that causes it (docs/standards/ticket-work.md → "Teardown,
 * limits and session closes are the platform's"). The model is never asked:
 * a suspended or ended policy binds nothing, so it could not close a session
 * if it tried.
 *
 * - **Suspended** (`trigger_changed`, `descriptor_changed`): its `active`
 *   records wait for machine access again (`waiting_machine`,
 *   `machine_access_suspended`, no machine), and their sessions get
 *   `policy_suspended` closes. Everything else keeps its state and waits.
 * - **Ended**: every live record is cancelled with `machine_access_ended`
 *   and its sessions get `policy_ended` closes — except when a confirmation
 *   replaced it, which hands its records to the new policy instead: a
 *   re-confirmation must not cancel the tickets it is re-confirming for.
 *
 * Each writes its `executor.policy.*` audit row in the same transaction, and
 * each that may free a machine enqueues the pool dispatcher
 * (`ticket-work.sweep`).
 */

export type StandingPolicyActor = { requestId?: string; userId: string | null }

type LiveRecord = {
  agentId: string
  executorId: string | null
  id: string
  policyId: string | null
  sessionIds: string[]
  status: string
  taskId: string
  triggerId: string | null
}

const RECORD_SELECT = {
  agentId: true, executorId: true, id: true, policyId: true, sessionIds: true, status: true, taskId: true,
  triggerId: true,
} as const

export const writeStandingPolicyAudit = async (
  tx: Prisma.TransactionClient,
  input: {
    action: string
    actor: StandingPolicyActor
    metadata: Record<string, unknown>
    organizationId: string
    policyId: string
  },
): Promise<void> => {
  await writeAuditEntryInTransaction(tx, {
    action: input.action,
    actorId: input.actor.userId ?? 'ticket-work',
    actorType: input.actor.userId ? 'user' : 'system',
    metadata: input.metadata as Prisma.InputJsonValue,
    organizationId: input.organizationId,
    outcome: 'success',
    requestId: input.actor.requestId ?? `standing-policy:${input.policyId}:${randomUUID()}`,
    resourceId: input.policyId,
    resourceType: 'executor_standing_policy',
  })
}

/**
 * Session-scoped close requests for the sessions these records started, each
 * on its own machine and named by its ticket's owner context under the policy
 * that pinned it, so nothing else of its author's is named.
 */
export const closeTicketWorkSessionsInTransaction = async (
  tx: Prisma.TransactionClient,
  records: readonly Pick<LiveRecord, 'agentId' | 'executorId' | 'policyId' | 'sessionIds' | 'taskId'>[],
  reason: ExecutorCodingSessionCloseReason,
  requestedByUserId: string | null,
): Promise<void> => {
  const withSessions = records.filter((record) => record.executorId && record.policyId && record.sessionIds.length > 0)
  if (withSessions.length === 0) return
  const authors = new Map((await tx.executorStandingPolicy.findMany({
    where: { id: { in: [...new Set(withSessions.map((record) => record.policyId as string))] } },
    select: { authorUserId: true, id: true },
  })).map((policy) => [policy.id, policy.authorUserId]))
  for (const record of withSessions) {
    const actorUserId = authors.get(record.policyId as string)
    if (!actorUserId) continue
    await requestExecutorCodingSessionCloseForSessionsInTransaction(tx, {
      executorId: record.executorId as string,
      owner: {
        actorUserId,
        agentId: record.agentId,
        contextId: ticketWorkCodingSessionContext(record.policyId as string, record.taskId),
      },
      reason,
      requestedByUserId,
      sessionIds: record.sessionIds,
    })
  }
}

export const suspendStandingPolicyInTransaction = async (
  tx: Prisma.TransactionClient,
  input: {
    actor: StandingPolicyActor
    detail: Record<string, unknown>
    policyId: string
    reason: ExecutorStandingPolicySuspendedReason
  },
): Promise<boolean> => {
  const { count } = await tx.executorStandingPolicy.updateMany({
    where: { id: input.policyId, status: 'live' },
    data: { status: 'suspended', suspendedReason: input.reason },
  })
  if (count === 0) return false
  const policy = await tx.executorStandingPolicy.findUniqueOrThrow({
    where: { id: input.policyId },
    select: { organizationId: true, triggerId: true },
  })
  const active = await tx.agentTicketWork.findMany({
    where: { policyId: input.policyId, status: 'active' },
    select: RECORD_SELECT,
  })
  await closeTicketWorkSessionsInTransaction(tx, active, 'policy_suspended', input.actor.userId)
  for (const record of active) {
    await tx.agentTicketWork.update({
      where: { id: record.id },
      data: { executorId: null, stateReason: 'machine_access_suspended', status: 'waiting_machine' },
    })
    await syncTicketWorkClock(tx, record.id)
    await recordTicketWorkActivity(tx, {
      work: record, eventType: 'work_paused', status: 'waiting_machine', reason: 'machine_access_suspended',
      by: input.actor.userId,
    })
  }
  if (active.length > 0) await enqueueTicketWorkSweep(tx)
  await writeStandingPolicyAudit(tx, {
    action: 'executor.policy.suspended',
    actor: input.actor,
    metadata: { ...input.detail, paused: active.length, reason: input.reason, triggerId: policy.triggerId },
    organizationId: policy.organizationId,
    policyId: input.policyId,
  })
  return true
}

/**
 * Queue records under a policy, each with why and where it stands, a
 * `work_queued` row and `ticket.work.queued`: the dispatcher takes them
 * from there.
 */
const queueRecords = async (
  tx: Prisma.TransactionClient,
  records: readonly Pick<LiveRecord, 'agentId' | 'id' | 'taskId' | 'triggerId'>[],
  input: { by: string | null; policyId: string },
): Promise<void> => {
  if (records.length === 0) return
  const reason = await standingPolicyPoolReason(tx, { policyId: input.policyId })
  const { organizationId } = await tx.executorStandingPolicy.findUniqueOrThrow({
    where: { id: input.policyId }, select: { organizationId: true },
  })
  for (const record of records) {
    const position = await queueTicketWorkInTransaction(tx, { policyId: input.policyId, reason, workId: record.id })
    await recordTicketWorkActivity(tx, { work: record, eventType: 'work_queued', status: 'queued', reason, by: input.by })
    await writeTicketWorkAudit(tx, {
      action: 'ticket.work.queued',
      by: input.by,
      metadata: { policyId: input.policyId, position, reason, taskId: record.taskId, triggerId: record.triggerId },
      organizationId,
      workId: record.id,
    })
  }
  await enqueueTicketWorkSweep(tx)
}

/**
 * Hand a replaced policy's live records to the policy that replaced it. Their
 * sessions belong to the old policy's owner context, which nothing will bind
 * again, so every one of them is closed, a parked record's included; an
 * `active` record goes back to the queue, unpinned, and the dispatcher
 * resumes it on the new pool with a `dequeued` wake.
 */
const handOverTicketWork = async (
  tx: Prisma.TransactionClient,
  records: readonly LiveRecord[],
  toPolicyId: string,
  requestedByUserId: string | null,
): Promise<void> => {
  await closeTicketWorkSessionsInTransaction(tx, records, 'policy_ended', requestedByUserId)
  const active = records.filter((record) => record.status === 'active')
  for (const record of records) {
    await tx.agentTicketWork.update({
      where: { id: record.id },
      data: record.status === 'active' ? { executorId: null, policyId: toPolicyId } : { policyId: toPolicyId },
    })
  }
  await queueRecords(tx, active, { by: requestedByUserId, policyId: toPolicyId })
  // Records already queued joined the new policy's queue too: every place is told again.
  await renumberTicketWorkQueueInTransaction(tx, toPolicyId)
}

export const endStandingPolicyInTransaction = async (
  tx: Prisma.TransactionClient,
  input: {
    actor: StandingPolicyActor
    /** Only for `replaced` by a confirmation: the policy its live records move to. */
    handOverTo?: string
    policyId: string
    reason: ExecutorStandingPolicyEndedReason
  },
): Promise<boolean> => {
  const policy = await tx.executorStandingPolicy.findUnique({
    where: { id: input.policyId },
    select: { organizationId: true, status: true, triggerId: true },
  })
  if (!policy || policy.status === 'ended') return false
  const { count } = await tx.executorStandingPolicy.updateMany({
    where: { id: input.policyId, status: policy.status },
    data: {
      endedAt: new Date(), endedByUserId: input.actor.userId, endedReason: input.reason, status: 'ended',
      suspendedReason: null,
    },
  })
  if (count === 0) return false
  const live = policy.status === 'preparing' ? [] : await tx.agentTicketWork.findMany({
    where: { policyId: input.policyId, status: { in: [...TICKET_WORK_LIVE_STATUSES] } },
    select: RECORD_SELECT,
  })
  if (input.handOverTo) {
    await handOverTicketWork(tx, live, input.handOverTo, input.actor.userId)
  } else {
    await closeTicketWorkSessionsInTransaction(tx, live, 'policy_ended', input.actor.userId)
    for (const record of live) {
      await endTicketWork(tx, {
        work: record, status: 'cancelled', reason: 'machine_access_ended', by: input.actor.userId ?? 'system',
      })
    }
    if (live.length > 0) await enqueueTicketWorkSweep(tx)
  }
  await writeStandingPolicyAudit(tx, {
    action: 'executor.policy.ended',
    actor: input.actor,
    metadata: {
      endedByUserId: input.actor.userId,
      ...(input.handOverTo ? { handedOverTo: input.handOverTo } : {}),
      previousStatus: policy.status,
      reason: input.reason,
      records: live.length,
      triggerId: policy.triggerId,
    },
    organizationId: policy.organizationId,
    policyId: input.policyId,
  })
  return true
}

/** End every policy a trigger holds — its card, and the one that binds — for one reason. */
export const endStandingPoliciesForTriggerInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { actor: StandingPolicyActor; reason: ExecutorStandingPolicyEndedReason; triggerId: string },
): Promise<number> => {
  const policies = await tx.executorStandingPolicy.findMany({
    where: { triggerId: input.triggerId, status: { not: 'ended' } },
    select: { id: true },
  })
  let ended = 0
  for (const policy of policies) {
    if (await endStandingPolicyInTransaction(tx, { actor: input.actor, policyId: policy.id, reason: input.reason })) {
      ended += 1
    }
  }
  return ended
}

/**
 * A confirmation's half of the queue: every record of this trigger waiting for
 * machine access — because access was suspended, or had not been set up when
 * the ticket was picked up — is queued under the confirmed policy, with its
 * reason, its place and a `work_queued` row, and the pool dispatcher is
 * enqueued to take it from there.
 */
export const queueTicketWorkForConfirmedPolicyInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { by?: string | null; policyId: string; triggerId: string },
): Promise<number> => {
  const waiting = await tx.agentTicketWork.findMany({
    where: {
      stateReason: { in: ['machine_access_suspended', 'machine_access_not_set_up'] },
      status: 'waiting_machine',
      triggerId: input.triggerId,
    },
    select: RECORD_SELECT,
  })
  for (const record of waiting) {
    await tx.agentTicketWork.update({ where: { id: record.id }, data: { executorId: null, policyId: input.policyId } })
  }
  await queueRecords(tx, waiting, { by: input.by ?? null, policyId: input.policyId })
  return waiting.length
}
