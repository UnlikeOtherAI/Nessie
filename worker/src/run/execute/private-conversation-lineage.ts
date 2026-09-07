import type { PrismaClient } from '@prisma/client'

import type { BasisScope, ConsumedSourceSink } from './disclosure-basis.js'

type MessageAuthorship = {
  agentId: string | null
  metadata: unknown
  onBehalfOfUserId: string | null
  role: string
  userId: string | null
}

const hasDelegatedAgentMetadata = (metadata: unknown): boolean =>
  typeof metadata === 'object'
  && metadata !== null
  && !Array.isArray(metadata)
  && (
    'delegatedByAgentId' in metadata
    || 'delegatedFromRunId' in metadata
  )

/**
 * `userId` can record the effective person for an agent-delivered action.
 * Original-author disclosure needs the narrower structural proof of a raw
 * human turn, which legacy delegated rows do not have.
 */
export const originalHumanAuthorId = (message: MessageAuthorship): string | null => {
  if (
    message.role !== 'user'
    || message.agentId !== null
    || message.onBehalfOfUserId !== null
    || hasDelegatedAgentMetadata(message.metadata)
  ) return null
  return message.userId
}

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
    select: { id: true, visibility: true },
  })
  markUnknownPrivateConversationChannels(sink, channels)
}

/** Mark known non-public channels when their source author is unavailable. */
export const markUnknownPrivateConversationChannels = (
  sink: ConsumedSourceSink,
  channels: readonly { id: string; visibility: string }[],
): void => {
  for (const channel of channels) {
    if (channel.visibility === 'public') continue
    sink.addPrivateConversationSource({
      sourceAuthorUserId: null,
      sourceChannelId: channel.id,
    })
  }
}
