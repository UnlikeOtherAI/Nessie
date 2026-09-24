import { Prisma } from '@prisma/client'

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
 * A position is only true while it is renumbered in every transaction that
 * changes the queue: a record joining it, leaving it — placed on a machine,
 * parked, ended, handed to another policy — or a queued ticket's priority
 * changing. Each of those calls one of the two functions here.
 *
 * Renumbering writes other records' rows, so it is serialised per policy by
 * `lockTicketWorkQueue`, and a transaction that moves a record in or out of
 * the queue takes that lock **before** it writes the record: a renumbering
 * that waits for the record's row then never holds the lock the mover waits
 * for.
 */

/** One policy's queue, while it is renumbered or a record joins or leaves it. */
export const lockTicketWorkQueue = async (
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  policyId: string,
): Promise<void> => {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ticket-work-queue:${policyId}`}, 0))`)
}

const PRIORITY_RANK: Readonly<Record<string, number>> = { urgent: 0, high: 1, medium: 2, low: 3 }

export type TicketWorkQueueEntry = { enqueuedAt: Date | null; id: string; priority: string }

/** Negative when `left` goes first. */
export const compareTicketWorkQueueEntries = (left: TicketWorkQueueEntry, right: TicketWorkQueueEntry): number =>
  (PRIORITY_RANK[left.priority] ?? 9) - (PRIORITY_RANK[right.priority] ?? 9)
  || (left.enqueuedAt?.getTime() ?? 0) - (right.enqueuedAt?.getTime() ?? 0)
  || left.id.localeCompare(right.id)

/**
 * Every queued record of one policy gets its place again, and a record of
 * that policy that is no longer queued keeps none. Returns the places, by
 * record id. Writes only the rows whose place changed.
 */
export const renumberTicketWorkQueueInTransaction = async (
  tx: Prisma.TransactionClient,
  policyId: string,
): Promise<Map<string, number>> => {
  await lockTicketWorkQueue(tx, policyId)
  await tx.agentTicketWork.updateMany({
    where: { policyId, queuePosition: { not: null }, status: { not: 'queued' } },
    data: { queuePosition: null },
  })
  const queued = await tx.agentTicketWork.findMany({
    where: { policyId, status: 'queued' },
    select: { enqueuedAt: true, id: true, queuePosition: true, task: { select: { priority: true } } },
  })
  const order = queued
    .map((record) => ({ ...record, priority: record.task.priority }))
    .sort(compareTicketWorkQueueEntries)
  const places = new Map(order.map((record, index) => [record.id, index + 1]))
  // Rows are written in id order, whatever the queue's order, so two writers never cross.
  for (const record of [...queued].sort((left, right) => left.id.localeCompare(right.id))) {
    const place = places.get(record.id)!
    if (record.queuePosition !== place) {
      await tx.agentTicketWork.update({ where: { id: record.id }, data: { queuePosition: place } })
    }
  }
  return places
}

/**
 * Whether queued work goes before this record on a free machine (T5): queued
 * work of any live policy whose pool includes the machine, and that is not
 * waiting for another machine it last worked on, ahead of it in the one
 * order. A pickup or a resume that finds a machine free then queues instead
 * of jumping the line, and the dispatcher places whoever is first.
 */
export const queuedTicketWorkOutranks = async (
  tx: Prisma.TransactionClient,
  input: { executorId: string; record: TicketWorkQueueEntry },
): Promise<boolean> => {
  const queued = await tx.agentTicketWork.findMany({
    where: {
      id: { not: input.record.id },
      policy: { executors: { some: { executorId: input.executorId } }, status: 'live' },
      status: 'queued',
      // Only work the dispatcher would place: a trigger in error keeps its records and places none.
      trigger: { enabled: true, status: 'active' },
    },
    select: { enqueuedAt: true, executorId: true, id: true, task: { select: { priority: true } } },
  })
  return queued.some((record) => (!record.executorId || record.executorId === input.executorId)
    && compareTicketWorkQueueEntries({ ...record, priority: record.task.priority }, input.record) < 0)
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
