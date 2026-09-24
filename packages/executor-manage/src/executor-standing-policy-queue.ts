import { Prisma } from '@prisma/client'
import { TICKET_WORK_MACHINE_HOLDING_STATUSES } from '@nessie/schemas'

import { executorHeartbeatCutoff } from './executor-liveness.js'

/**
 * The order of the pool queue, and the place every queued record is told it
 * holds (docs/plans/2026-09-23-ticket-driven-agents/ticket-work.md → "The
 * pool queue (T4 assigns, T5 dequeues)"; docs/standards/ticket-work-machine-access.md).
 *
 * One order everywhere: the ticket's priority (urgent first), then when the
 * record joined the queue (`enqueuedAt`), then its id so two records queued in
 * the same instant still have one order. The dispatcher dequeues by it across
 * every policy that shares a machine, and each record's `queuePosition` is its
 * place in its own policy's queue by it.
 *
 * Every transaction that changes the queue renumbers it: a record joining it,
 * leaving it — placed on a machine, parked, ended, handed to another policy —
 * or a queued ticket's priority changing. A record leaving the queue clears
 * its own place as it leaves; the renumbering writes the others'.
 *
 * Renumbering writes other records' rows, so it never waits for one: rows
 * another transaction holds are skipped (`SKIP LOCKED`) and take their place
 * at the next renumbering — the sweep's dequeue renumbers every queue it
 * reads. Renumberings of one policy are serialised by `lockTicketWorkQueue`,
 * so two never compute places from different snapshots at once, and since a
 * holder of that lock never waits on a row, it cannot close a cycle with a
 * transaction that holds a record and wants the lock.
 */

const PRIORITY_RANK: Readonly<Record<string, number>> = { urgent: 0, high: 1, medium: 2, low: 3 }

export type TicketWorkQueueEntry = { enqueuedAt: Date | null; id: string; priority: string }

/** Negative when `left` goes first. */
export const compareTicketWorkQueueEntries = (left: TicketWorkQueueEntry, right: TicketWorkQueueEntry): number =>
  (PRIORITY_RANK[left.priority] ?? 9) - (PRIORITY_RANK[right.priority] ?? 9)
  || (left.enqueuedAt?.getTime() ?? 0) - (right.enqueuedAt?.getTime() ?? 0)
  || left.id.localeCompare(right.id)

/** One policy's queue, while it is renumbered. */
export const lockTicketWorkQueue = async (
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  policyId: string,
): Promise<void> => {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ticket-work-queue:${policyId}`}, 0))`)
}

/**
 * Every queued record of one policy gets its place again. Returns the places,
 * by record id; writes only the rows whose place changed and that no other
 * transaction holds.
 */
export const renumberTicketWorkQueueInTransaction = async (
  tx: Prisma.TransactionClient,
  policyId: string,
): Promise<Map<string, number>> => {
  await lockTicketWorkQueue(tx, policyId)
  const queued = await tx.agentTicketWork.findMany({
    where: { policyId, status: 'queued' },
    select: { enqueuedAt: true, id: true, queuePosition: true, task: { select: { priority: true } } },
  })
  const order = queued
    .map((record) => ({ ...record, priority: record.task.priority }))
    .sort(compareTicketWorkQueueEntries)
  const places = new Map(order.map((record, index) => [record.id, index + 1]))
  const moved = queued.filter((record) => record.queuePosition !== places.get(record.id)).map((record) => record.id)
  if (moved.length === 0) return places
  const free = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id::text AS id FROM agent_ticket_work
    WHERE id IN (${Prisma.join(moved.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY id
    FOR UPDATE SKIP LOCKED`)
  for (const { id } of free) {
    await tx.agentTicketWork.update({ where: { id }, data: { queuePosition: places.get(id) ?? null } })
  }
  return places
}

/**
 * Whether queued work goes before this record on a free machine (T5): queued
 * work of any live policy whose pool includes the machine, ahead of it in the
 * one order, that could take this machine — its own last machine is this one,
 * it has none, or its own is offline, out of its pool or held by other work (a
 * record waits for its own machine only while that machine could take it; its
 * own sessions there never keep it off). A pickup or a resume
 * that finds a machine free then queues instead of jumping the line, and the
 * dispatcher places whoever is first.
 */
export const queuedTicketWorkOutranks = async (
  tx: Prisma.TransactionClient,
  input: { executorId: string; now?: Date; record: TicketWorkQueueEntry },
): Promise<boolean> => {
  const now = input.now ?? new Date()
  const queued = (await tx.agentTicketWork.findMany({
    where: {
      id: { not: input.record.id },
      policy: { executors: { some: { executorId: input.executorId } }, status: 'live' },
      status: 'queued',
      // Only work the dispatcher would place: a trigger in error keeps its records and places none.
      trigger: { agentId: { not: null }, enabled: true, status: 'active' },
    },
    select: {
      enqueuedAt: true, executorId: true, id: true, task: { select: { priority: true } },
      executor: { select: { lastSeenAt: true, removedAt: true, status: true } },
      policy: { select: { executors: { select: { executorId: true } } } },
    },
  })).filter((record) => compareTicketWorkQueueEntries({ ...record, priority: record.task.priority }, input.record) < 0)
  if (queued.length === 0) return false
  const elsewhere = [...new Set(queued.flatMap((record) => (
    record.executorId && record.executorId !== input.executorId ? [record.executorId] : [])))]
  const held = new Set((await tx.agentTicketWork.findMany({
    where: { executorId: { in: elsewhere }, status: { in: [...TICKET_WORK_MACHINE_HOLDING_STATUSES] } },
    select: { executorId: true },
  })).map((record) => record.executorId))
  const cutoff = executorHeartbeatCutoff(now)
  return queued.some((record) => {
    if (!record.executorId || record.executorId === input.executorId) return true
    const own = record.executor
    const pooled = record.policy?.executors.some((row) => row.executorId === record.executorId) ?? false
    const ownCouldTakeIt = pooled && own && !own.removedAt && own.status === 'online' && own.lastSeenAt !== null
      && own.lastSeenAt >= cutoff && !held.has(record.executorId)
    return !ownCouldTakeIt
  })
}

/**
 * The queues a ticket is waiting in, renumbered: its priority changed, so its
 * place — and its neighbours' — may have. Nothing wakes.
 */
export const renumberTicketWorkQueuesForTaskInTransaction = async (
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<void> => {
  const queued = await tx.agentTicketWork.findMany({
    where: { policyId: { not: null }, status: 'queued', taskId },
    select: { policyId: true },
  })
  for (const policyId of new Set(queued.map((record) => record.policyId as string))) {
    await renumberTicketWorkQueueInTransaction(tx, policyId)
  }
}
