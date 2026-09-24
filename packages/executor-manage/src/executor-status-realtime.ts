import type { PrismaClient } from '@prisma/client'
import type { PgRealtimeTransport } from '@nessie/runtime'
import { parseOrganizationId } from '@nessie/schemas'
import { canViewExecutor, resolveExecutorHumanAccess } from './executor-access.js'
import { executorHeartbeatCutoff, expireStaleExecutorHeartbeats } from './executor-liveness.js'

type StatusTransport = Pick<PgRealtimeTransport, 'publishWs'>

/** Same live entitlement as the inventory, including private assignments. */
export const canReadExecutorStatus = async (
  prisma: PrismaClient,
  input: { executorId: string; organizationId: string; userId: string },
): Promise<boolean> => {
  // A final removal notice may reach people who could see the retained row.
  const executor = await prisma.executor.findFirst({
    where: { id: input.executorId, organizationId: input.organizationId },
    select: { id: true, projectId: true, scopeKind: true },
  })
  return executor !== null && canViewExecutor(executor, await resolveExecutorHumanAccess(
    prisma, input.organizationId, input.userId, executor,
  ))
}

/** Publish committed state; listeners recheck visibility before sending bytes. */
export const publishExecutorStatus = async (
  prisma: PrismaClient,
  transport: StatusTransport,
  executorId: string,
): Promise<void> => {
  const executor = await prisma.executor.findUnique({
    where: { id: executorId },
    select: {
      id: true, organizationId: true, status: true, statusDetail: true,
      lastSeenAt: true, updatedAt: true, removedAt: true,
    },
  })
  if (!executor) return
  await transport.publishWs([{ kind: 'executor_inventory', organizationId: parseOrganizationId(executor.organizationId) }], {
    event: 'executor.status.changed',
    data: {
      executorId: executor.id, status: executor.status, statusDetail: executor.statusDetail,
      lastSeenAt: executor.lastSeenAt?.toISOString() ?? null,
      updatedAt: executor.updatedAt.toISOString(), removed: executor.removedAt !== null,
    },
  })
}

/**
 * A silent machine must go offline even when nobody makes another REST read.
 * Include recent lazy expirations: a command poll or REST read may have won
 * the update before this sweep. Repeated frames carry the same updatedAt.
 */
export const publishExpiredExecutorStatuses = async (
  prisma: PrismaClient,
  transport: StatusTransport,
  now = new Date(),
): Promise<void> => {
  const stale = await prisma.executor.findMany({
    where: {
      removedAt: null,
      OR: [
        { status: 'online', OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: executorHeartbeatCutoff(now) } }] },
        { status: 'offline', statusDetail: 'Executor heartbeat expired.',
          updatedAt: { gte: new Date(now.getTime() - 60_000) } },
      ],
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  for (const executor of stale) {
    await expireStaleExecutorHeartbeats(prisma, { executorId: executor.id }, now)
    await publishExecutorStatus(prisma, transport, executor.id)
  }
}
