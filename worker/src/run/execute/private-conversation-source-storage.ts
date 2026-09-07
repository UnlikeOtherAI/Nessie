import type { Prisma, PrismaClient } from '@prisma/client'

import type { PrivateConversationSource } from './disclosure-basis.js'

type ChannelLookup = Pick<PrismaClient | Prisma.TransactionClient, 'channel'>

/**
 * A deleted source channel remains in the in-memory denial sink and run basis,
 * but cannot be written to `MessageDisclosureSource` because that relation has
 * a channel foreign key. Keep all extant source rows and omit only deleted
 * channels; their surviving channel basis still fails closed at read time.
 */
export const persistablePrivateConversationSources = async (
  prisma: ChannelLookup,
  sources: readonly PrivateConversationSource[],
): Promise<PrivateConversationSource[]> => {
  if (sources.length === 0) return []
  const existing = await prisma.channel.findMany({
    where: { id: { in: [...new Set(sources.map((source) => source.sourceChannelId))] } },
    select: { id: true },
  })
  const channelIds = new Set(existing.map((channel) => channel.id))
  return sources.filter((source) => channelIds.has(source.sourceChannelId))
}
