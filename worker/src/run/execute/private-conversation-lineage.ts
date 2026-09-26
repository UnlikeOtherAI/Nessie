import type { PrismaClient } from '@prisma/client'
import { originalHumanAuthorId, type RawHumanMessage } from '@nessie/runtime'
import { z } from 'zod'

import {
  BasisScopeSchema,
  PrivateConversationSourceSchema,
  type BasisScope,
  type ConsumedSourceSink,
  type PrivateConversationSource,
} from './disclosure-basis.js'

const ChannelDecisionLineageSchema = z.object({
  basisScopes: z.array(BasisScopeSchema),
  disclosureSources: z.array(PrivateConversationSourceSchema),
})

export type PrivateConversationLineage = {
  basisScopes: readonly BasisScope[]
  disclosureSources: readonly {
    sourceAuthorUserId: string | null
    sourceChannelId: string
  }[]
}

export { originalHumanAuthorId }

/**
 * What reading one conversation turn admits into a run's provenance.
 *
 * Its own basis and source rows, and — because human text in a non-public room
 * has no MessageBasisScope; it is the source rather than a derived reply — that
 * room and the turn's original human author, so a later post into another
 * audience cannot erase that provenance. A legacy private agent/tool row can
 * carry another person's words but predates source lineage: its author is
 * recorded as unknown, and a known author from another turn cannot cover it.
 *
 * The transcript (`loadConversation`) and the one-on-one classifier window
 * read turns alike, so they admit them through this one definition.
 */
export const conversationTurnLineage = (
  message: RawHumanMessage & PrivateConversationLineage,
  channel: { id: string; visibility: string },
): { basisScopes: BasisScope[]; disclosureSources: PrivateConversationSource[] } => {
  const disclosureSources = [...message.disclosureSources]
  if (channel.visibility !== 'public') {
    const authorUserId = originalHumanAuthorId(message)
    if (authorUserId) {
      disclosureSources.push({ sourceAuthorUserId: authorUserId, sourceChannelId: channel.id })
    } else if (message.disclosureSources.length === 0) {
      disclosureSources.push({ sourceAuthorUserId: null, sourceChannelId: channel.id })
    }
  }
  return { basisScopes: [...message.basisScopes], disclosureSources }
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

/**
 * A trigger can age out of the recent transcript while its agent is busy.
 * Its own channel and raw human author must therefore enter the sink here,
 * before the trigger (or pinned instructions containing it) becomes a prompt.
 * Hidden system kickoffs retain their explicit lineage rather than acquiring
 * an invented author from the room they were delivered into.
 */
export const admitTriggerMessageLineage = async (
  prisma: PrismaClient,
  sink: ConsumedSourceSink,
  message: PrivateConversationLineage & RawHumanMessage & {
    channelDecision?: unknown
    thread: { channel: { id: string; visibility: string } }
  },
): Promise<void> => {
  const sources = [...message.disclosureSources]
  const channel = message.thread.channel
  if (channel.visibility !== 'public' && message.role !== 'system') {
    const authorUserId = originalHumanAuthorId(message)
    if (authorUserId || sources.length === 0) {
      sources.push({ sourceAuthorUserId: authorUserId, sourceChannelId: channel.id })
    }
  }
  await admitPrivateConversationLineage(prisma, sink, { ...message, disclosureSources: sources })
  // The classifier can have read older turns and policy instructions that no
  // longer appear in the transcript when its selected work starts. Their
  // durable provenance follows every outcome derived from that classification.
  if (message.channelDecision !== undefined && message.channelDecision !== null) {
    const lineage = ChannelDecisionLineageSchema.parse(message.channelDecision)
    await admitPrivateConversationLineage(prisma, sink, lineage)
  }
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
