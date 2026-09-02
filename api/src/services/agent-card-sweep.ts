import type { PrismaClient } from '@prisma/client'

/**
 * A card with an expiry stops accepting answers when it lapses.
 *
 * The transition is the same conditional UPDATE a press uses, so a sweep and a
 * person pressing at the same moment still have exactly one winner. No message
 * is posted: the frozen card and its context note are the record, and a message
 * per expiry is the noise the rolling watch status exists to avoid.
 */
export const sweepExpiredAgentCards = async (
  prisma: Pick<PrismaClient, 'agentCard'>,
): Promise<string[]> => {
  const now = new Date()
  const lapsed = await prisma.agentCard.findMany({
    select: { id: true },
    take: 200,
    where: { expiresAt: { lte: now, not: null }, status: 'open' },
  })
  if (lapsed.length === 0) return []

  const expired: string[] = []
  for (const card of lapsed) {
    const claimed = await prisma.agentCard.updateMany({
      data: { status: 'expired' },
      where: { expiresAt: { lte: now }, id: card.id, status: 'open' },
    })
    if (claimed.count === 1) expired.push(card.id)
  }
  return expired
}

/**
 * Cancelling a run cancels the card it was waiting on: the person can no
 * longer answer a run that will never read the answer. Mirrors
 * `expirePendingToolApprovalsForRun`.
 */
export const cancelAgentCardsForRun = async (
  prisma: Pick<PrismaClient, 'agentCard'>,
  runId: string,
): Promise<void> => {
  await prisma.agentCard.updateMany({
    data: { status: 'cancelled' },
    where: { status: 'open', waitRunId: runId },
  })
}
