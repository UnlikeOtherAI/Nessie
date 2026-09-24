import type { Prisma, PrismaClient } from '@prisma/client'
import {
  closeTicketWorkSessionsInTransaction,
  compareTicketWorkQueueEntries,
  endTicketWork,
  placeTicketWorkOnExecutorInTransaction,
  recordTicketWorkActivity,
  standingPolicyDigestDrift,
  suspendStandingPolicyInTransaction,
  writeTicketWorkAudit,
  writeTicketWorkThreadRow,
} from '@nessie/executor-manage'
import { TicketChangedStoredConfigSchema, type TicketTriggerDeliveryPayload } from '@nessie/schemas'
import { canMemberEditProjectBoards, lockTicketColumn } from '@nessie/team-admin'

import { ticketWorkConfigOf } from './ticket-work-kickoff.js'
import { queueTicketWorkRun, stopTicketWorkAtWakeLimit } from './ticket-work-run.js'
import { lockThreadRunSlot } from '../run/thread-serialization.js'

/**
 * The pool dispatcher's dequeue (T5; docs/plans/2026-09-23-ticket-driven-agents/ticket-work.md
 * → "The pool queue (T4 assigns, T5 dequeues)"; docs/standards/ticket-work-machine-access.md).
 * The sweep runs it, and every transaction that may free a machine enqueues the sweep.
 *
 * Machines are shared across triggers, so the queue belongs to the machine: for each machine
 * of a live policy's pool, in id order, the queued records of **every** live policy whose pool
 * includes it are read in one order — a record that last worked on this machine first (its
 * sessions are there), then ticket priority, then age — and the first that can take it does.
 * A record that last worked on another machine of its pool waits for that one while it still
 * stands: in the pool, not removed, heard from within the trigger's `waitingMachineHours`.
 *
 * Before any placement a policy is checked against what its author confirmed: a trigger or a
 * machine whose digests moved suspends it (`trigger_changed`, `descriptor_changed`), exactly as
 * the doors that change them do, so its records wait for a new confirmation rather than being
 * placed under terms nobody agreed to — or cancelled one by one for a change none of them made.
 *
 * Each placement takes the locks every wake of the record takes, in the one order — the ticket,
 * the thread's run slot, then the pool and the machine — re-reads the record still `queued`,
 * and re-checks the record itself: its ticket still in a start-work column (else `left_flow`),
 * and the person whose move started it still a live member who can edit the board (else
 * `mover_lost_access`). Either failure cancels it, with its `work_ended` row and a stop row in
 * its thread, and the next record is tried. Placed, the record is `active` with a `work_resumed`
 * row, `ticket.work.started` (`dequeued: true`), a delivered `dequeue` delivery and one
 * `dequeued` wake: "a machine is free; you are bound to it". A machine another record holds,
 * or one gone offline, takes nobody this round; one at this ticket's own session quota lets the
 * next record try. Two sweeps racing for a machine serialise on its lock, and the partial
 * unique index `agent_ticket_work_one_per_executor` holds whatever else happens.
 */

const DEQUEUED_SUMMARY = 'a machine is free; you are bound to it'

const dequeuedText = (movedOff: boolean): string =>
  'A machine is free, so this ticket\'s queued work starts now on one of its owner\'s machines, and you are bound '
  + 'to it. Read the ticket, then brief the coding agent. Never name the machine on the ticket or in this thread.'
  + (movedOff
    ? ' The coding session this ticket had on its last machine is gone with that machine: start a new one whose '
      + 'brief says what was already done, and the pull request below if there is one.'
    : '')

type Policy = {
  executors: Array<{ descriptorConfigDigest: string; executorId: string; localPolicyDigest: string }>
  id: string
  organizationId: string
  pinnedTerms: unknown
  trigger: {
    agentId: string | null
    config: unknown
    enabled: boolean
    id: string
    status: string
    targetChannelId: string | null
  } | null
  triggerDigest: string
}

type Machine = { id: string; lastSeenAt: Date | null; removedAt: Date | null; status: string }

type Candidate = {
  agentId: string
  enqueuedAt: Date | null
  executorId: string | null
  id: string
  policyId: string
  priority: string
  projectId: string
  startedByUserId: string | null
  taskId: string
  threadId: string
  triggerId: string | null
}

export type DequeueOutcome = 'assigned' | 'held' | 'offline' | 'quota' | 'cancelled' | 'stale'

/** Live policies with queued work, whose trigger is on and whose confirmed digests still hold. */
const standingPolicies = async (prisma: PrismaClient): Promise<Policy[]> => {
  const policies = await prisma.executorStandingPolicy.findMany({
    where: { status: 'live', ticketWork: { some: { status: 'queued' } } },
    select: {
      id: true, organizationId: true, pinnedTerms: true, triggerDigest: true,
      executors: { select: { descriptorConfigDigest: true, executorId: true, localPolicyDigest: true } },
      trigger: {
        select: { agentId: true, config: true, enabled: true, id: true, status: true, targetChannelId: true },
      },
    },
  })
  const standing: Policy[] = []
  for (const policy of policies) {
    if (!policy.trigger?.agentId || !policy.trigger.enabled || policy.trigger.status !== 'active') continue
    const drift = await standingPolicyDigestDrift(prisma, policy)
    if (drift) {
      await prisma.$transaction((tx) => suspendStandingPolicyInTransaction(tx, {
        actor: { userId: null }, detail: { foundAt: 'dequeue' }, policyId: policy.id, reason: drift,
      }))
      continue
    }
    standing.push(policy)
  }
  return standing
}

/** Whether a record's last machine still counts as its own: in its pool, not removed, not away too long. */
const stillItsOwn = (machine: Machine | undefined, policy: Policy, now: Date): boolean => {
  if (!machine || machine.removedAt || machine.status === 'revoked') return false
  if (!policy.executors.some((row) => row.executorId === machine.id)) return false
  const hours = ticketWorkConfigOf(policy.trigger?.config).waitingMachineHours
  return machine.lastSeenAt !== null && now.getTime() - machine.lastSeenAt.getTime() < hours * 3_600_000
}

/** The records one machine may take, in the order it takes them. */
const candidatesFor = (
  executorId: string,
  queued: readonly Candidate[],
  context: { machines: ReadonlyMap<string, Machine>; now: Date; policies: ReadonlyMap<string, Policy> },
): Candidate[] => queued
  .filter((record) => {
    const policy = context.policies.get(record.policyId)
    if (!policy?.executors.some((row) => row.executorId === executorId)) return false
    return !record.executorId || record.executorId === executorId
      || !stillItsOwn(context.machines.get(record.executorId), policy, context.now)
  })
  .sort((left, right) => (
    Number(right.executorId === executorId) - Number(left.executorId === executorId)
    || compareTicketWorkQueueEntries(left, right)
  ))

const STOPPED_SUMMARY = {
  left_flow: 'the ticket left its start-work column while it waited for a machine, so its queued work ended',
  mover_lost_access: 'the person whose move started this work can no longer edit the board, so its queued work ended',
} as const

/** A queued record that no longer stands: cancelled, with its reason where the ticket and its thread show it. */
const cancelQueued = async (
  tx: Prisma.TransactionClient,
  record: Candidate,
  reason: keyof typeof STOPPED_SUMMARY,
): Promise<void> => {
  const sessions = await tx.agentTicketWork.findUniqueOrThrow({
    where: { id: record.id }, select: { executorId: true, policyId: true, sessionIds: true },
  })
  await closeTicketWorkSessionsInTransaction(tx, [{ ...record, ...sessions }], 'ticket_left_flow', null)
  if (!await endTicketWork(tx, { by: 'system', reason, status: 'cancelled', work: record })) return
  await writeTicketWorkThreadRow(tx, {
    threadId: record.threadId,
    event: { kind: 'stopped', reason, summary: STOPPED_SUMMARY[reason], workId: record.id },
  })
}

const recordDequeue = async (
  tx: Prisma.TransactionClient,
  input: { executorId: string; movedOff: boolean; policy: Policy; record: Candidate },
): Promise<void> => {
  const { policy, record } = input
  const trigger = policy.trigger!
  const work = { ...record, triggerId: trigger.id }
  await recordTicketWorkActivity(tx, { eventType: 'work_resumed', reason: null, status: 'active', work })
  await writeTicketWorkAudit(tx, {
    action: 'ticket.work.started',
    metadata: {
      dequeued: true, executorId: input.executorId, policyId: policy.id, taskId: record.taskId, triggerId: trigger.id,
    },
    organizationId: policy.organizationId,
    workId: record.id,
  })
  const payload: TicketTriggerDeliveryPayload = {
    eventType: 'dequeued', originKind: 'system', outcome: 'follow', taskId: record.taskId, wakeReason: 'dequeued',
    workId: record.id,
  }
  const delivery = await tx.agentTriggerDelivery.create({
    data: {
      dedupeKey: `dequeue:${record.id}:${new Date().toISOString()}`, deliveredAt: new Date(), payload, source: 'dequeue',
      status: 'delivered', triggerId: trigger.id,
    },
    select: { id: true },
  })
  const outcome = await queueTicketWorkRun(tx, {
    work: record,
    trigger: {
      agentId: trigger.agentId!, config: trigger.config, id: trigger.id, organizationId: policy.organizationId,
    },
    event: {
      at: new Date().toISOString(), reason: 'dequeued', summary: DEQUEUED_SUMMARY, text: dequeuedText(input.movedOff),
    },
    deliveryId: delivery.id,
  })
  if (outcome.kind !== 'over_limit') return
  await stopTicketWorkAtWakeLimit(tx, { work, wakesUsed: outcome.wakesUsed })
  await tx.agentTriggerDelivery.update({
    where: { id: delivery.id },
    data: { errorMessage: 'limit_wakes', payload: { ...payload, outcome: 'skipped', skipReason: 'limit_wakes' }, status: 'skipped' },
  })
}

/** Whether the record joined the queue last because its machine stayed offline: its session there is gone. */
const queuedOffAnOfflineMachine = async (tx: Prisma.TransactionClient, record: Candidate): Promise<boolean> => {
  const queued = await tx.taskEvent.findFirst({
    where: { eventType: 'work_queued', payload: { path: ['workId'], equals: record.id }, taskId: record.taskId },
    orderBy: { createdAt: 'desc' },
    select: { payload: true },
  })
  const payload = queued?.payload as { previousReason?: unknown } | null | undefined
  return payload?.previousReason === 'machine_offline'
}

/** One record onto one machine, under every lock its wakes take; the re-checks first. */
export const dequeueOnto = async (
  prisma: PrismaClient,
  input: { executorId: string; now: Date; policy: Policy; record: Candidate },
): Promise<DequeueOutcome> => prisma.$transaction(async (tx) => {
  const { policy, record } = input
  const columnId = await lockTicketColumn(tx, record.taskId)
  await lockThreadRunSlot(tx, { agentId: record.agentId, threadId: record.threadId })
  const fresh = await tx.agentTicketWork.findUnique({
    where: { id: record.id }, select: { executorId: true, policyId: true, status: true },
  })
  if (fresh?.status !== 'queued' || fresh.policyId !== policy.id) return 'stale'
  const config = TicketChangedStoredConfigSchema.safeParse(policy.trigger?.config)
  const pickup = new Set(config.success ? config.data.pickup?.columnIds ?? [] : [])
  if (!columnId || !pickup.has(columnId)) {
    await cancelQueued(tx, record, 'left_flow')
    return 'cancelled'
  }
  const moverStands = record.startedByUserId !== null && await canMemberEditProjectBoards(tx, {
    organizationId: policy.organizationId, projectId: record.projectId, userId: record.startedByUserId,
  })
  if (!moverStands) {
    await cancelQueued(tx, record, 'mover_lost_access')
    return 'cancelled'
  }
  const movedOff = (fresh.executorId !== null && fresh.executorId !== input.executorId)
    || await queuedOffAnOfflineMachine(tx, record)
  const state = await placeTicketWorkOnExecutorInTransaction(tx, {
    executorId: input.executorId, now: input.now, workId: record.id,
  })
  if (state === 'not_live') return 'stale'
  if (state !== 'free') return state
  await recordDequeue(tx, { executorId: input.executorId, movedOff, policy, record })
  return 'assigned'
})

/** Every free machine of a live pool takes the first queued record that can take it. Returns how many started. */
export const dequeueTicketWork = async (prisma: PrismaClient, deps: { now: Date }): Promise<number> => {
  const policies = await standingPolicies(prisma)
  if (policies.length === 0) return 0
  const byId = new Map(policies.map((policy) => [policy.id, policy]))
  const machineIds = [...new Set(policies.flatMap((policy) => policy.executors.map((row) => row.executorId)))].sort()
  const queued = (await prisma.agentTicketWork.findMany({
    where: { policyId: { in: [...byId.keys()] }, status: 'queued' },
    select: {
      agentId: true, enqueuedAt: true, executorId: true, id: true, policyId: true, projectId: true,
      startedByUserId: true, taskId: true, threadId: true, triggerId: true, task: { select: { priority: true } },
    },
  })).map(({ task, ...record }) => ({ ...record, policyId: record.policyId as string, priority: task.priority }))
  const lastMachines = [...new Set(queued.flatMap((record) => (record.executorId ? [record.executorId] : [])))]
  const machines = new Map((await prisma.executor.findMany({
    where: { id: { in: [...new Set([...machineIds, ...lastMachines])] } },
    select: { id: true, lastSeenAt: true, removedAt: true, status: true },
  })).map((machine) => [machine.id, machine]))
  const taken = new Set<string>()
  let started = 0
  for (const executorId of machineIds) {
    const candidates = candidatesFor(executorId, queued.filter((record) => !taken.has(record.id)), {
      machines, now: deps.now, policies: byId,
    })
    for (const record of candidates) {
      const policy = byId.get(record.policyId)!
      const outcome = await dequeueOnto(prisma, { executorId, now: deps.now, policy, record })
      // Placed or gone, a record is done with; one this machine could not take waits for another.
      if (outcome === 'assigned' || outcome === 'cancelled' || outcome === 'stale') taken.add(record.id)
      if (outcome === 'assigned') started += 1
      if (outcome === 'assigned' || outcome === 'held' || outcome === 'offline') break
    }
  }
  return started
}
