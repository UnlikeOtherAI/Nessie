import type { Prisma, PrismaClient } from '@prisma/client'

import type { BasisScopeRow } from './disclosure-predicate.js'

/**
 * Writing a message's disclosure: the basis scopes it may be shown under and
 * the private conversations it carries words from. Shared by every writer
 * that stamps a message in its own transaction — an agent run's reply, a tool
 * posting into another room, and a server-authored message (a DeepWater
 * research result, notice or wake) — so a message is never written with a
 * weaker disclosure than the one its content needs.
 */

type Tx = Prisma.TransactionClient | PrismaClient

export type MessagePrivateConversationSource = {
  sourceAuthorUserId: string | null
  sourceChannelId: string
}

/**
 * A deleted source channel remains in the in-memory denial sink and run basis,
 * but cannot be written to `MessageDisclosureSource` because that relation has
 * a channel foreign key. Keep all extant source rows and omit only deleted
 * channels; their surviving channel basis still fails closed at read time.
 */
export const persistablePrivateConversationSources = async <T extends MessagePrivateConversationSource>(
  prisma: Pick<Tx, 'channel'>,
  sources: readonly T[],
): Promise<T[]> => {
  if (sources.length === 0) return []
  const existing = await prisma.channel.findMany({
    where: { id: { in: [...new Set(sources.map((source) => source.sourceChannelId))] } },
    select: { id: true },
  })
  const channelIds = new Set(existing.map((channel) => channel.id))
  return sources.filter((source) => channelIds.has(source.sourceChannelId))
}

/**
 * Attach a basis to a message.
 *
 * `skipDuplicates` plus the fact that nothing here deletes rows is what makes an
 * *edit* a union rather than a replacement: an edit may narrow what a message
 * says, never relax what it is allowed to say.
 */
export const insertMessageBasis = async (
  tx: Tx,
  input: { messageId: string; organizationId: string; basis: readonly BasisScopeRow[] },
): Promise<void> => {
  if (input.basis.length === 0) {
    return
  }
  await tx.messageBasisScope.createMany({
    data: input.basis.map((scope) => ({
      messageId: input.messageId,
      organizationId: input.organizationId,
      scopeId: scope.scopeId,
      scopeType: scope.scopeType,
    })),
    skipDuplicates: true,
  })
}

/** Preserve the private-conversation authors a message's content came from. */
export const insertMessageDisclosureSources = async (
  tx: Tx,
  input: {
    messageId: string
    organizationId: string
    sources: readonly MessagePrivateConversationSource[]
  },
): Promise<void> => {
  const persisted = await persistablePrivateConversationSources(tx, input.sources)
  if (persisted.length === 0) return
  await tx.messageDisclosureSource.createMany({
    data: persisted.map((source) => ({
      messageId: input.messageId,
      organizationId: input.organizationId,
      sourceAuthorUserId: source.sourceAuthorUserId,
      sourceChannelId: source.sourceChannelId,
    })),
    skipDuplicates: true,
  })
}
