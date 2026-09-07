import type { PrismaClient } from '@prisma/client'
import { AgentCardSpecSchema } from '@nessie/schemas'

import {
  loadReadableCard,
  readBrowserLoginHandoff,
  type LoadedAgentCard,
} from './agent-cards.js'

/**
 * Finds the one card a browser viewer may complete. The JSON marker is only a
 * candidate; the structured action, card audience, disclosure basis and clock
 * are all checked before it can release a human-controlled session.
 */
export const findBrowserLoginCardForViewer = async (
  prisma: PrismaClient,
  input: {
    agentBrowserId: string
    organizationId: string
    threadId: string
    userId: string
  },
): Promise<LoadedAgentCard | null> => {
  const candidates = await prisma.agentCard.findMany({
    select: { id: true },
    where: {
      organizationId: input.organizationId,
      status: 'open',
      threadId: input.threadId,
      waitRunId: { not: null },
    },
  })
  for (const candidate of candidates) {
    const card = await loadReadableCard(prisma, {
      cardId: candidate.id,
      organizationId: input.organizationId,
      userId: input.userId,
    })
    if (
      !card
      || (card.expiresAt !== null && card.expiresAt.getTime() <= Date.now())
      || (card.respondentUserIds.length > 0 && !card.respondentUserIds.includes(input.userId))
    ) continue
    const spec = AgentCardSpecSchema.safeParse(card.spec)
    const handoff = readBrowserLoginHandoff(card.browserLogin)
    if (
      spec.success
      && handoff?.agentBrowserId === input.agentBrowserId
      && spec.data.actions.some((action) => action.key === 'done')
    ) return card
  }
  return null
}
