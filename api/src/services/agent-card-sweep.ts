import { Prisma, type PrismaClient } from '@prisma/client'
import {
  releaseCloudBrowserSession,
  type CloudBrowserDeps,
} from '@nessie/browser-cloud'

import { readTemporaryBrowserLogin } from './agent-cards.js'

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
    where: {
      expiresAt: { lte: now, not: null },
      status: 'open',
      OR: [
        { browserLogin: { equals: Prisma.DbNull } },
        { NOT: { browserLogin: { path: ['mode'], equals: 'temporary' } } },
      ],
    },
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
 * Expiring a temporary browser-login card must also free its parked thread.
 * The regular card sweep deliberately has no run semantics, so this narrow
 * companion claims only temporary-login cards and terminalizes only their
 * recorded `waitRunId` before releasing the no-context browser session.
 */
export const sweepExpiredTemporaryBrowserLoginCards = async (
  deps: CloudBrowserDeps,
  cancelWaitingRun: (input: {
    organizationId: string
    runId: string
    userId: string
  }) => Promise<void>,
): Promise<string[]> => {
  const now = new Date()
  const cards = await deps.prisma.agentCard.findMany({
    select: {
      browserLogin: true,
      id: true,
      organizationId: true,
      respondentUserIds: true,
      status: true,
      waitRunId: true,
    },
    take: 200,
    where: {
      browserLogin: { path: ['mode'], equals: 'temporary' },
      OR: [
        { status: 'expired', waitRun: { status: 'waiting_input' } },
        { expiresAt: { lte: now, not: null }, status: 'open' },
      ],
    },
  })
  const expired: string[] = []
  for (const card of cards) {
    const login = readTemporaryBrowserLogin(card.browserLogin)
    const waitRunId = card.waitRunId
    if (!login || !waitRunId) continue
    const cleanup = await deps.prisma.$transaction(async (tx) => {
      if (card.status === 'open') {
        const claimed = await tx.agentCard.updateMany({
          data: { status: 'expired' },
          where: { expiresAt: { lte: now }, id: card.id, status: 'open' },
        })
        if (claimed.count !== 1) return null
      }

      const grant = await tx.browserPersonalAccessGrant.findFirst({
        where: { id: login.grantId, runId: waitRunId },
        select: { sessionId: true, userId: true },
      })
      await tx.browserPersonalAccessGrant.updateMany({
        data: { revokedAt: now, status: 'expired' },
        where: { id: login.grantId, runId: waitRunId, status: { in: ['pending', 'active'] } },
      })
      const userId = grant?.userId ?? card.respondentUserIds[0]
      return userId ? { sessionId: grant?.sessionId ?? null, userId } : null
    })
    if (!cleanup) continue
    await cancelWaitingRun({
      organizationId: card.organizationId,
      runId: waitRunId,
      userId: cleanup.userId,
    })
    if (cleanup.sessionId) {
      await releaseCloudBrowserSession(deps, {
        releasedBy: 'expired_browser_login_card',
        sessionId: cleanup.sessionId,
      })
    }
    expired.push(card.id)
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
