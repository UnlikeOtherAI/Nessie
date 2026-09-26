import type { PrismaClient } from '@prisma/client'
import type { OneOnOneOffer, PgRealtimeTransport } from '@nessie/runtime'
import {
  AgentCardSpecSchema,
  PreparedCardActionsSchema,
  parseChannelId,
  parseThreadId,
} from '@nessie/schemas'
import { renderAgentCardPlainText } from '@nessie/team-admin'

/**
 * A typed answer to a card of prepared buttons, in a one-on-one room
 * (docs/standards/agent-cards.md → "A prepared button runs its call").
 *
 * A person who has just been offered "Thursday 10:00 / Friday 14:00" writes
 * "friday works" as often as they press. Jev decides whether the words take
 * one of the buttons exactly as offered; everything that makes the card a
 * candidate is structural and decided here first:
 * - the message is top-level in the main chat, and the message right above it
 *   is the card — so the words can only be answering that card;
 * - the card is the room agent's own, still open, unexpired, not waited on by
 *   a parked run, and has at least one prepared button;
 * - the person may answer it (`respondentUserIds`);
 * - the card message carries no disclosure restriction, because a typed
 *   answer, unlike a press, does not inherit the card's basis.
 */
export type AnswerableCard = {
  cardId: string
  messageId: string
  offer: OneOnOneOffer
  threadId: string
}

export const loadAnswerableCard = async (
  prisma: Pick<PrismaClient, 'agentCard' | 'message'>,
  input: {
    agentId: string
    threadId: string
    trigger: { createdAt: Date; id: string; rootMessageId: string | null; userId?: string | null }
  },
): Promise<AnswerableCard | null> => {
  const { trigger } = input
  if (trigger.rootMessageId !== null || !trigger.userId) return null
  const previous = await prisma.message.findFirst({
    where: {
      createdAt: { lte: trigger.createdAt },
      deletedAt: null,
      id: { not: trigger.id },
      role: { in: ['user', 'assistant'] },
      rootMessageId: null,
      threadId: input.threadId,
    },
    orderBy: { createdAt: 'desc' },
    select: { basisScopes: { select: { scopeId: true }, take: 1 }, id: true },
  })
  if (!previous || previous.basisScopes.length > 0) return null
  const card = await prisma.agentCard.findUnique({
    where: { messageId: previous.id },
    select: {
      agentId: true, expiresAt: true, id: true, messageId: true, preparedActions: true,
      respondentUserIds: true, spec: true, status: true, waitRunId: true,
    },
  })
  if (!card || card.agentId !== input.agentId || card.status !== 'open' || card.waitRunId) return null
  if (card.expiresAt && card.expiresAt.getTime() <= Date.now()) return null
  if (card.respondentUserIds.length > 0 && !card.respondentUserIds.includes(trigger.userId)) return null
  const spec = AgentCardSpecSchema.safeParse(card.spec)
  const prepared = PreparedCardActionsSchema.safeParse(card.preparedActions)
  if (!spec.success || !prepared.success) return null
  const options = spec.data.actions.flatMap((action) => {
    const call = prepared.data[action.key]
    return call
      ? [{ key: action.key, label: action.label, does: `runs ${call.tool} with ${JSON.stringify(call.arguments)}` }]
      : []
  })
  if (options.length === 0) return null
  return {
    cardId: card.id,
    messageId: card.messageId,
    offer: { options, text: renderAgentCardPlainText(spec.data) },
    threadId: input.threadId,
  }
}

/**
 * Resolve the card with the typed message as its answer — the same claim a
 * press makes (`status = 'open'` in the WHERE), so a press racing the words
 * has exactly one winner. The announcement after it is best-effort, as a
 * press's is: the card is resolved either way.
 */
export const claimCardWithTypedAnswer = async (
  deps: { prisma: Pick<PrismaClient, 'agentCard'>; realtimeTransport?: Pick<PgRealtimeTransport, 'publishWs'> },
  input: { actionKey: string; card: AnswerableCard; channelId: string; messageId: string; userId: string },
): Promise<boolean> => {
  const now = new Date()
  const claimed = await deps.prisma.agentCard.updateMany({
    data: {
      resolvedActionKey: input.actionKey,
      resolvedAt: now,
      resolvedByUserId: input.userId,
      responseMessageId: input.messageId,
      status: 'resolved',
    },
    where: {
      id: input.card.cardId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      responseMessageId: null,
      status: 'open',
    },
  })
  if (claimed.count !== 1) return false
  await deps.realtimeTransport?.publishWs([{ kind: 'channel', channelId: parseChannelId(input.channelId) }], {
    data: {
      cardId: input.card.cardId,
      messageId: input.card.messageId,
      status: 'resolved',
      threadId: parseThreadId(input.card.threadId),
    },
    event: 'card.updated',
  }).catch((error: unknown) => console.warn('[worker] card.updated publish failed after a typed answer', error))
  return true
}
