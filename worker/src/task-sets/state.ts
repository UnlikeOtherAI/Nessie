import { Prisma, type PrismaClient } from '@prisma/client'
import { enqueueTaskSet, lockTaskSet } from '@nessie/team-admin'

export class TaskSetWait extends Error {
  constructor(readonly reason: string, readonly offline = false) { super(reason) }
}
export class TaskSetBlocked extends Error {
  constructor(readonly reason: string) { super(reason) }
}

export const changeTaskSetHealth = async (
  prisma: PrismaClient, id: string,
  input: TaskSetHealthChange,
): Promise<void> => prisma.$transaction((tx) => changeTaskSetHealthInTransaction(tx, id, input))

type TaskSetHealthChange = { reason: string; waiting?: boolean; offline?: boolean; now?: Date; delayMs?: number }

export const changeTaskSetHealthInTransaction = async (
  tx: Prisma.TransactionClient, id: string, input: TaskSetHealthChange,
): Promise<void> => {
  const now = input.now ?? new Date()
  const delayMs = input.delayMs ?? 30_000
    await lockTaskSet(tx, id)
    const set = await tx.taskSet.findUniqueOrThrow({ where: { id } })
    if (['paused', 'cancelled', 'completed'].includes(set.status)) return
    const offlineSince = input.offline ? set.offlineSince ?? now : null
    const prolonged = offlineSince !== null && now.getTime() - offlineSince.getTime() >= 30 * 60_000
    const shouldAlert = !input.waiting || prolonged
    const reason = prolonged ? 'processor_offline_prolonged' : input.reason
    const changed = set.reason !== reason || set.status !== (input.waiting ? 'waiting' : 'blocked')
    const updated = await tx.taskSet.update({ where: { id }, data: {
      status: input.waiting ? 'waiting' : 'blocked', reason, offlineSince,
      statusChangedAt: changed ? now : set.statusChangedAt,
      healthRevision: { increment: changed ? 1 : 0 }, revision: { increment: 1 },
      nextAttemptAt: new Date(now.getTime() + delayMs),
    } })
    if (shouldAlert) await tx.userAlert.upsert({
      where: { userId_eventKey: { userId: set.ownerUserId, eventKey: `task-set-health:${id}:${updated.healthRevision}` } },
      create: { organizationId: set.organizationId, userId: set.ownerUserId,
        kind: 'task_set_health', taskSetId: id, eventKey: `task-set-health:${id}:${updated.healthRevision}` },
      update: {},
    })
    if (input.waiting) await enqueueTaskSet(tx, id, updated.revision, delayMs)
}

export const sweepTaskSets = async (prisma: PrismaClient, now = new Date()): Promise<void> => {
  const active = { OR: [
    { status: { in: ['running', 'waiting', 'importing'] } },
    { currentItemId: { not: null } },
    { status: 'completed', deliveryStatus: 'pending' },
  ] }
  const due = await prisma.taskSet.findMany({
    where: { ...active, nextAttemptAt: { lte: now } },
    orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: 50, select: { id: true },
  })
  for (const row of due) await prisma.$transaction(async (tx) => {
    const updated = await tx.taskSet.updateMany({
      where: { id: row.id, ...active, nextAttemptAt: { lte: now } },
      // Waking a due set must not move its eligibility into the future. Run
      // fencing makes duplicate sweep deliveries harmless during execution.
      data: { revision: { increment: 1 } },
    })
    if (updated.count === 0) return
    const set = await tx.taskSet.findUniqueOrThrow({ where: { id: row.id }, select: { revision: true } })
    await enqueueTaskSet(tx, row.id, set.revision)
  })
}

export const lockTaskSetCapacity = async (tx: Prisma.TransactionClient, key: string): Promise<void> => {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 17))`)
}
