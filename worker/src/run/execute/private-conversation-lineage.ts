import type { PrismaClient } from '@prisma/client'

import type { BasisScope, ConsumedSourceSink } from './disclosure-basis.js'

/**
 * Older carry-forward records retain channel scopes but not original human
 * authors. Preserve that missing fact explicitly: a later readable B turn in
 * the same room must not make B appear able to consent for the older source.
 */
export const markUnknownPrivateConversationScopes = async (
  prisma: PrismaClient,
  sink: ConsumedSourceSink,
  scopes: readonly BasisScope[],
): Promise<void> => {
  const channelIds = [...new Set(scopes
    .filter((scope) => scope.scopeType === 'channel')
    .map((scope) => scope.scopeId))]
  if (channelIds.length === 0) return

  const channels = await prisma.channel.findMany({
    where: { id: { in: channelIds }, visibility: { not: 'public' } },
    select: { id: true },
  })
  for (const channel of channels) {
    sink.addPrivateConversationSource({
      sourceAuthorUserId: null,
      sourceChannelId: channel.id,
    })
  }
}
