import type { PrismaClient } from '@prisma/client'

const RETENTION_MS = 60 * 60_000

/**
 * Bounds encrypted local prompt/output transport independently of a host's
 * liveness. The caller owns the cluster-wide sweep lock.
 */
export const sweepExpiredLocalInferenceTransport = async (
  prisma: PrismaClient,
  now = new Date(),
): Promise<void> => {
  await prisma.localInferenceAttempt.updateMany({
    where: {
      deadlineAt: { lte: now },
      state: { in: ['queued', 'leased', 'accepted'] },
    },
    data: { failureReason: 'deadline_exceeded', state: 'expired', terminalAt: now },
  })
  const cutoff = new Date(now.getTime() - RETENTION_MS)
  const terminal = await prisma.localInferenceAttempt.findMany({
    where: { terminalAt: { lte: cutoff } },
    select: { id: true },
    take: 200,
  })
  await prisma.localInferenceFrame.deleteMany({
    where: {
      OR: [
        { acknowledgedAt: { lte: cutoff } },
        ...(terminal.length ? [{ attemptId: { in: terminal.map((attempt) => attempt.id) } }] : []),
      ],
    },
  })
  if (terminal.length) {
    await prisma.localInferenceAttempt.deleteMany({ where: { id: { in: terminal.map((attempt) => attempt.id) } } })
  }
}
