import type { PrismaClient } from '@prisma/client'
import type { PairingAudit } from './executor-code-pairing.js'
import { lockPairing, revokePairingExecutor } from './executor-code-proof.js'

/** A stopped companion cannot strand a claimed code in the person's machine
 * list. Every read retires expired provisional rows in that caller's tenant. */
export const expireExecutorCodePairings = async (
  prisma: PrismaClient, organizationId: string, audit: PairingAudit, now = new Date(),
): Promise<void> => {
  const expired = await prisma.executorPairingCode.findMany({ where: {
    expiresAt: { lte: now }, confirmedAt: null, rejectedAt: null,
    executor: { organizationId, status: 'pending_pairing' },
  }, select: { id: true }, take: 100 })
  for (const reference of expired) {
    await prisma.$transaction(async (tx) => {
      await lockPairing(tx, reference.id)
      const pairing = await tx.executorPairingCode.findUnique({
        where: { id: reference.id }, include: { executor: true },
      })
      if (!pairing?.executor || pairing.confirmedAt || pairing.rejectedAt
        || pairing.expiresAt > now || pairing.executor.status !== 'pending_pairing') return
      // Still `pending_pairing`: never connected, so it holds no lease to announce.
      await revokePairingExecutor(tx, pairing.executor.id)
      await audit(tx, {
        action: 'executor.pairing.expired', executorId: pairing.executor.id,
        organizationId, userId: pairing.executor.pairingOwnerUserId,
      })
    })
  }
}
