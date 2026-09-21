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
  input: { reason: string; waiting?: boolean; offline?: boolean; now?: Date },
): Promise<void> => {
  const now = input.now ?? new Date()
  await prisma.$transaction(async (tx) => {
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
      nextAttemptAt: new Date(now.getTime() + 30_000),
    } })
    if (shouldAlert) await tx.userAlert.upsert({
      where: { userId_eventKey: { userId: set.ownerUserId, eventKey: `task-set-health:${id}:${updated.healthRevision}` } },
      create: { organizationId: set.organizationId, userId: set.ownerUserId,
        kind: 'task_set_health', taskSetId: id, eventKey: `task-set-health:${id}:${updated.healthRevision}` },
      update: {},
    })
    if (input.waiting) await enqueueTaskSet(tx, id, updated.revision, 30_000)
  })
}

export const sweepTaskSets = async (prisma: PrismaClient, now = new Date()): Promise<void> => {
  const due = await prisma.taskSet.findMany({
    where: { status: { in: ['running', 'waiting', 'importing'] }, nextAttemptAt: { lte: now } },
    orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: 50, select: { id: true },
  })
  for (const row of due) await prisma.$transaction(async (tx) => {
    const updated = await tx.taskSet.updateMany({
      where: { id: row.id, status: { in: ['running', 'waiting', 'importing'] }, nextAttemptAt: { lte: now } },
      data: { nextAttemptAt: new Date(now.getTime() + 60_000), revision: { increment: 1 } },
    })
    if (updated.count === 0) return
    const set = await tx.taskSet.findUniqueOrThrow({ where: { id: row.id }, select: { revision: true } })
    await enqueueTaskSet(tx, row.id, set.revision)
  })
}

export const lockTaskSetCapacity = async (tx: Prisma.TransactionClient, key: string): Promise<void> => {
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 17))`)
}
