import type { Prisma } from '@prisma/client'

export const controlLocalInferenceAttempt = async (input: {
  attemptId: string
  dispatchFence: number
  hostId: string
  now: Date
  stillAuthorized: () => Promise<boolean>
  tx: Prisma.TransactionClient
}): Promise<'active' | 'cancelled' | 'expired' | 'fenced'> => {
  if (!await input.stillAuthorized()) return 'fenced'
  const attempt = await input.tx.localInferenceAttempt.findFirst({
    where: { id: input.attemptId, hostId: input.hostId },
    select: { deadlineAt: true, dispatchFence: true, state: true },
  })
  if (!attempt || attempt.dispatchFence !== input.dispatchFence) return 'fenced'
  if (attempt.state === 'cancelled') return 'cancelled'
  if (attempt.state === 'completed' || attempt.state === 'failed' || attempt.state === 'expired') return 'fenced'
  if (attempt.deadlineAt <= input.now) {
    await input.tx.localInferenceAttempt.updateMany({
      where: { id: input.attemptId, state: { in: ['queued', 'leased', 'accepted'] } },
      data: { failureReason: 'deadline_exceeded', state: 'expired', terminalAt: input.now },
    })
    return 'expired'
  }
  const renewed = await input.tx.localInferenceAttempt.updateMany({
    where: {
      id: input.attemptId,
      dispatchFence: input.dispatchFence,
      state: { in: ['leased', 'accepted'] },
    },
    data: {
      acceptedAt: attempt.state === 'leased' ? input.now : undefined,
      leaseExpiresAt: new Date(input.now.getTime() + 60_000),
      state: 'accepted',
    },
  })
  return renewed.count === 1 ? 'active' : 'fenced'
}
