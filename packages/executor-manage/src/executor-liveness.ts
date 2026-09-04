import type { Prisma, PrismaClient } from '@prisma/client'

/**
 * Daemons heartbeat every twenty seconds. Three missed heartbeats are the one
 * server-side boundary between an online executor and an unavailable one.
 */
export const EXECUTOR_HEARTBEAT_FRESHNESS_MS = 60_000

type ExecutorLivenessStore = Pick<PrismaClient, 'executor'>

type ExecutorLivenessScope =
  | { executorId: string; organizationId?: never }
  | { executorId?: never; organizationId: string }

export const executorHeartbeatCutoff = (now: Date): Date =>
  new Date(now.getTime() - EXECUTOR_HEARTBEAT_FRESHNESS_MS)

/**
 * Persist the liveness transition with the timestamp predicate on the write.
 * A heartbeat or claim racing this update therefore wins only when it writes a
 * genuinely fresh `lastSeenAt`; an old snapshot cannot knock it back offline.
 */
export const expireStaleExecutorHeartbeats = async (
  prisma: ExecutorLivenessStore | Prisma.TransactionClient,
  scope: ExecutorLivenessScope,
  now = new Date(),
): Promise<number> => {
  const expired = await prisma.executor.updateMany({
    where: {
      ...(scope.executorId ? { id: scope.executorId } : {}),
      ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
      status: 'online',
      OR: [
        { lastSeenAt: null },
        { lastSeenAt: { lt: executorHeartbeatCutoff(now) } },
      ],
    },
    data: {
      status: 'offline',
      statusDetail: 'Executor heartbeat expired.',
    },
  })
  return expired.count
}
