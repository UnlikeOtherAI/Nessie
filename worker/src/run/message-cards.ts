import type { PrismaClient } from '@prisma/client'
import { AgentCardSpecSchema } from '@nessie/schemas'
import { buildAgentCardStateNote } from '@nessie/workspace-admin'

/**
 * Cards in the model's context.
 *
 * A card's *state* lives on its row, not in the message text, so a resolved
 * card would otherwise read to a later run exactly as it did when it was
 * posted — the agent would keep asking a question somebody already answered.
 * This renders the live state as one line joined beside the message content,
 * precisely where the attachment inventory line goes (`message-attachments.ts`),
 * and is computed at render time so nothing ever has to rewrite a message.
 */
export const loadMessageCardNotes = async (
  prisma: Pick<PrismaClient, 'agentCard'>,
  organizationId: string,
  messageIds: string[],
): Promise<Map<string, string>> => {
  if (messageIds.length === 0) return new Map()

  const cards = await prisma.agentCard.findMany({
    select: {
      expiresAt: true,
      messageId: true,
      resolutionValues: true,
      resolvedActionKey: true,
      resolvedAt: true,
      resolvedBy: { select: { displayName: true } },
      respondentUserIds: true,
      secretOutcomes: true,
      spec: true,
      status: true,
    },
    where: { messageId: { in: messageIds }, organizationId },
  })
  if (cards.length === 0) return new Map()

  // One lookup for every name any of these cards is waiting on, rather than a
  // query per card.
  const waitingUserIds = [
    ...new Set(cards.flatMap((card) => (card.status === 'open' ? card.respondentUserIds : []))),
  ]
  const names = new Map<string, string>()
  if (waitingUserIds.length > 0) {
    const users = await (prisma as unknown as PrismaClient).user.findMany({
      select: { displayName: true, id: true },
      where: { id: { in: waitingUserIds } },
    })
    for (const user of users) names.set(user.id, user.displayName)
  }

  const notes = new Map<string, string>()
  for (const card of cards) {
    const spec = AgentCardSpecSchema.safeParse(card.spec)
    // A spec that no longer parses (an older schema version, say) is skipped
    // rather than guessed at: a wrong note is worse than none.
    if (!spec.success) continue

    const values = (card.resolutionValues ?? {}) as Record<string, string | number | boolean>
    const secretOutcomes = (card.secretOutcomes ?? {}) as Record<string, unknown>
    notes.set(
      card.messageId,
      buildAgentCardStateNote({
        expiresAt: card.expiresAt,
        resolutionValues: values,
        resolvedActionKey: card.resolvedActionKey,
        resolvedAtLabel: card.resolvedAt?.toISOString() ?? null,
        resolvedByName: card.resolvedBy?.displayName ?? null,
        secretKeys: Object.keys(secretOutcomes),
        spec: spec.data,
        status: card.status,
        waitingForNames: card.respondentUserIds.map(
          (userId) => names.get(userId) ?? 'someone in this conversation',
        ),
      }),
    )
  }
  return notes
}
