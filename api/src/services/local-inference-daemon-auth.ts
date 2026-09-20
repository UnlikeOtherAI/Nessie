import type { Prisma, PrismaClient } from '@prisma/client'

type LocalInferenceHostRecord = {
  connectionEpoch: number
  custodianUserId: string
  executorId: string | null
  id: string
  organizationId: string
  publicKey: string | null
  transport: 'desktop' | 'executor'
}

export type LocalInferenceDaemonAuthorization = {
  executorConnectionEpoch: string | null
  host: LocalInferenceHostRecord
  machinePublicKey: string
}

type ExecutorConnection = {
  activeConnectionEpoch: bigint
  id: string
  machinePublicKey: string
}

type LocalInferenceDatabase = Pick<PrismaClient, 'executor' | 'localInferenceHost'>

const currentExecutor = async (
  prisma: LocalInferenceDatabase,
  host: LocalInferenceHostRecord,
): Promise<ExecutorConnection | null> => {
  if (!host.executorId) return null
  return prisma.executor.findFirst({
    where: {
      id: host.executorId,
      machinePublicKey: { not: null },
      organizationId: host.organizationId,
      pairingOwnerUserId: host.custodianUserId,
      status: 'online',
    },
    select: { activeConnectionEpoch: true, id: true, machinePublicKey: true },
  }) as Promise<ExecutorConnection | null>
}

/**
 * Resolve the only key that may authenticate a host. Desktop hosts own their
 * exact native key; executor hosts borrow the current paired executor key and
 * additionally have to name its active daemon epoch. There is no fallback
 * between the two authority shapes.
 */
export const authorizeLocalInferenceDaemon = async (
  prisma: LocalInferenceDatabase,
  input: {
    executorConnectionEpoch?: string
    hostId: string
    organizationId: string
  },
): Promise<LocalInferenceDaemonAuthorization | null> => {
  const host = await prisma.localInferenceHost.findFirst({
    where: { id: input.hostId, organizationId: input.organizationId, revokedAt: null },
    select: {
      connectionEpoch: true,
      custodianUserId: true,
      executorId: true,
      id: true,
      organizationId: true,
      publicKey: true,
      transport: true,
    },
  })
  if (!host) return null
  if (host.transport === 'desktop') {
    if (host.executorId !== null || !host.publicKey || input.executorConnectionEpoch !== undefined) return null
    return { executorConnectionEpoch: null, host, machinePublicKey: host.publicKey }
  }
  // The SQL transport-authority constraint makes this shape mandatory too;
  // keeping the check at the reader protects old/partially migrated rows.
  if (host.transport !== 'executor' || host.publicKey !== null || !host.executorId) return null
  const executor = await currentExecutor(prisma, host)
  if (!executor || input.executorConnectionEpoch !== executor.activeConnectionEpoch.toString()) return null
  return {
    executorConnectionEpoch: executor.activeConnectionEpoch.toString(),
    host,
    machinePublicKey: executor.machinePublicKey,
  }
}

/** Recheck the executor fence inside any local-inference write transaction. */
export const executorLocalInferenceDaemonStillAuthorized = async (
  tx: Prisma.TransactionClient,
  authorization: LocalInferenceDaemonAuthorization,
): Promise<boolean> => {
  if (authorization.executorConnectionEpoch === null) return true
  const executor = await currentExecutor(tx, authorization.host)
  return executor !== null
    && executor.activeConnectionEpoch.toString() === authorization.executorConnectionEpoch
}
