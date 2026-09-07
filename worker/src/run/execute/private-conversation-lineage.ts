import type { PrismaClient } from '@prisma/client'
import { originalHumanAuthorId } from '@nessie/runtime'

import type { BasisScope, ConsumedSourceSink } from './disclosure-basis.js'

export type PrivateConversationLineage = {
  basisScopes: readonly BasisScope[]
  disclosureSources: readonly {
    sourceAuthorUserId: string | null
    sourceChannelId: string
  }[]
}

export { originalHumanAuthorId }

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
    where: { id: { in: channelIds } },
    select: { id: true, visibility: true },
  })
  const nonPublicChannels = channels.filter((channel) => channel.visibility !== 'public')
  const resolvedChannelIds = new Set(channels.map((channel) => channel.id))
  // A deleted source row cannot retain a MessageDisclosureSource foreign key,
  // but its basis may survive in a checkpoint or handoff. Missing must mean
  // unknown, never public: otherwise deleting a channel reopens an external
  // write after the source was already consumed.
  markUnknownPrivateConversationChannels(sink, [
    ...nonPublicChannels,
    ...channelIds
      .filter((channelId) => !resolvedChannelIds.has(channelId))
      .map((id) => ({ id, visibility: 'unknown' })),
  ])
}

/**
 * A server-authored trigger (handoff or delegated subtask) is outside the
 * normal transcript window. Admit both forms of provenance before its content
 * becomes the run prompt. Older trigger rows may have channel basis without an
 * author row; record that absence only for source channels not otherwise
 * represented, so a complete modern source stays eligible for its author's
 * deliberate one-message consent.
 */
export const admitPrivateConversationLineage = async (
  prisma: PrismaClient,
  sink: ConsumedSourceSink,
  lineage: PrivateConversationLineage,
): Promise<void> => {
  sink.addAll(lineage.basisScopes)
  for (const source of lineage.disclosureSources) {
    sink.addPrivateConversationSource(source)
  }
  const representedChannels = new Set(lineage.disclosureSources.map(
    (source) => source.sourceChannelId,
  ))
  await markUnknownPrivateConversationScopes(
    prisma,
    sink,
    lineage.basisScopes.filter(
      (scope) => scope.scopeType !== 'channel' || !representedChannels.has(scope.scopeId),
    ),
  )
}

/** Admit server-authored hidden trigger content before it becomes a run prompt. */
export const admitTriggerMessageLineage = async (
  prisma: PrismaClient,
  sink: ConsumedSourceSink,
  message: PrivateConversationLineage,
): Promise<void> => admitPrivateConversationLineage(prisma, sink, message)

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
