import type { PrismaClient } from '@prisma/client'
import { AgentCardSpecSchema } from '@nessie/schemas'

import {
  loadReadableCard,
  readBrowserLoginHandoff,
  readTemporaryBrowserLogin,
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

/** Finds the exact temporary-login card whose grant owns this private session. */
export const findTemporaryBrowserLoginCardForViewer = async (
  prisma: PrismaClient,
  input: { organizationId: string; sessionId: string; threadId: string; userId: string },
): Promise<LoadedAgentCard | null> => {
  const grant = await prisma.browserPersonalAccessGrant.findUnique({
    where: { sessionId: input.sessionId }, select: { id: true },
  })
  if (!grant) return null
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
    if (!card || (card.expiresAt !== null && card.expiresAt <= new Date())) continue
    const login = readTemporaryBrowserLogin(card.browserLogin)
    if (login?.grantId === grant.id) return card
  }
  return null
}
