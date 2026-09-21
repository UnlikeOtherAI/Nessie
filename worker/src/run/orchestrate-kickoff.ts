import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { originalHumanAuthorId, type OrchestratorDecision } from '@nessie/runtime'
import { ChannelDecisionSnapshotSchema, type OrchestrateDecideJobPayload } from '@nessie/schemas'

// One hidden kickoff per source/agent/principal. Its primary key is the replay
// guard, including two workers reaching the upsert at the same time.
const kickoffId = (messageId: string, agentId: string, principal?: string): string => {
  const hex = createHash('sha256').update(`nessie:channel-policy:${messageId}:${agentId}:${principal ?? ''}`)
    .digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Keeps a configured task and its authority separate from the poster's request. */
export const ensureChannelPolicyKickoff = async (
  tx: Prisma.TransactionClient,
  payload: OrchestrateDecideJobPayload,
  decision: Extract<OrchestratorDecision, { action: 'reply' }>,
): Promise<string> => {
  if (!decision.policyWork || !decision.promptOverride) throw new Error('A policy kickoff requires pinned work')
  const source = await tx.message.findUniqueOrThrow({
    where: { id: payload.messageId },
    select: {
      id: true, threadId: true, role: true, userId: true, agentId: true, onBehalfOfUserId: true, rootMessageId: true,
      metadata: true,
      basisScopes: { select: { scopeType: true, scopeId: true } },
      disclosureSources: { select: { sourceAuthorUserId: true, sourceChannelId: true } },
      channelDecision: true, thread: { select: { channelId: true, channel: { select: { visibility: true } } } },
    },
  })
  if (source.threadId !== payload.threadId || source.thread.channelId !== payload.channelId) {
    throw new Error('A policy kickoff must remain in its source conversation')
  }
  const snapshot = ChannelDecisionSnapshotSchema.parse(source.channelDecision)
  const ownScope = source.thread.channel.visibility !== 'public'
    ? [{ scopeType: 'channel', scopeId: payload.channelId }] : []
  const ownSources = ownScope.length ? [{
    sourceAuthorUserId: originalHumanAuthorId(source), sourceChannelId: payload.channelId,
  }] : []
  const pinned = {
    ...snapshot, decisions: [decision],
    basisScopes: [...snapshot.basisScopes, ...source.basisScopes, ...ownScope],
    disclosureSources: [...snapshot.disclosureSources, ...source.disclosureSources, ...ownSources],
  }
  const id = kickoffId(source.id, decision.agentId, decision.principalUserId)
  await tx.message.upsert({
    where: { id }, update: {},
    create: {
      id, threadId: payload.threadId, agentId: decision.agentId, role: 'system',
      content: decision.promptOverride, rootMessageId: source.rootMessageId ?? source.id,
      channelDecision: pinned as Prisma.InputJsonValue,
      metadata: { channelPolicyKickoff: { sourceMessageId: source.id } },
    },
    select: { id: true },
  })
  return id
}
