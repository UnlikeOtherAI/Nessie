import type { Prisma, PrismaClient } from '@prisma/client'

import {
  computeReplyBasis,
  subtractImpliedScopes,
  type BasisScope,
} from '../execute/disclosure-basis.js'
import { persistablePrivateConversationSources } from '../execute/private-conversation-source-storage.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'

type Tx = Prisma.TransactionClient | PrismaClient

/** Delegation turns model-authored content into another run's prompt. */
export const requireConsumedSources = (
  context: Pick<BuiltinToolRuntimeContext, 'consumedSources'>,
): NonNullable<BuiltinToolRuntimeContext['consumedSources']> => {
  if (!context.consumedSources) {
    throw new Error('Cannot delegate content without a disclosure provenance sink.')
  }
  return context.consumedSources
}

/**
 * Disclosure stamping for messages a *tool* writes.
 *
 * `worker/src/run/execute/agent-message.ts` is the chokepoint for a run's own
 * reply, and it can take the destination straight off the run context because
 * the reply always lands where the run is. A tool cannot: `send_message` targets
 * another channel, and `message_edit` targets an existing message that may sit
 * in another thread. Each therefore has to resolve its own destination chain
 * before it can ask what the destination already implies.
 *
 * That resolution and its write existed once, inline in `send_message`. This is
 * the same code, named, so the second and third callers reuse it instead of
 * restating it — a restated stamp is one that drifts.
 */

/**
 * What a run has consumed that posting into `channelId` would not already imply.
 *
 * Empty when the run consumed nothing, so the common case costs no query at all.
 */
export const resolveToolPostBasis = async (
  context: Pick<BuiltinToolRuntimeContext, 'consumedSources' | 'prisma' | 'channel'>,
  channelId: string,
): Promise<BasisScope[]> => {
  const consumed = context.consumedSources?.list() ?? []
  if (consumed.length === 0) {
    return []
  }
  const [channel, boundAgents] = await Promise.all([
    context.prisma.channel.findUnique({
      where: { id: channelId },
      select: { projectId: true, teamId: true },
    }),
    // This target may differ from the run's reply channel, so its implication
    // set must be resolved independently rather than reusing RunContext.
    context.prisma.agentBinding.findMany({
      where: { channelId },
      select: { agentId: true },
    }),
  ])
  if (!channel) {
    return []
  }
  return computeReplyBasis(
    consumed,
    {
      channelId,
      organizationId: String(context.channel.organizationId),
      projectId: channel.projectId,
      teamId: channel.teamId,
    },
    boundAgents.map((binding) => binding.agentId),
  )
}

/**
 * The basis of a message one run writes to start *another* run.
 *
 * Two subtractions, in order:
 * 1. what the destination already implies (`computeReplyBasis`), the ordinary
 *    rule every reply obeys;
 * 2. what `requesterScopes` already satisfies — and this one is only ever
 *    correct when the destination's audience *is* that one person.
 *
 * The second is load-bearing where it applies and a disclosure hole where it
 * does not. `agent_handoff` writes into the requester's own single-member DM,
 * so a scope they cannot satisfy would silence the specialist in its own home
 * while withholding nothing (they heard the content in the origin thread).
 * Hand `requesterScopes: []` for any destination with a second reader — a
 * shared room, a project channel — where subtracting one person's reach would
 * publish restricted material to everybody else in it.
 *
 * `targetAgentIds` are the agents bound to the destination: an `agent` scope
 * they satisfy is not privileged there, exactly as `computeReplyBasis` treats a
 * run's own bound agents.
 */
export const computeDelegatedPostBasis = (input: {
  consumed: readonly BasisScope[]
  destination: {
    channelId: string
    organizationId: string
    projectId: string
    teamId: string
  }
  requesterScopes: readonly BasisScope[]
  targetAgentIds: readonly string[]
}): BasisScope[] =>
  subtractImpliedScopes(
    computeReplyBasis(input.consumed, input.destination, input.targetAgentIds),
    input.requesterScopes,
  )

/**
 * Attach a basis to a message.
 *
 * `skipDuplicates` plus the fact that nothing here deletes rows is what makes an
 * *edit* a union rather than a replacement: an edit may narrow what a message
 * says, never relax what it is allowed to say.
 */
export const insertMessageBasis = async (
  tx: Tx,
  input: { messageId: string; organizationId: string; basis: readonly BasisScope[] },
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

/** Preserve private-conversation authors when a tool posts into another room. */
export const insertPrivateConversationSources = async (
  tx: Tx,
  context: Pick<BuiltinToolRuntimeContext, 'consumedSources'>,
  input: { messageId: string; organizationId: string },
): Promise<void> => {
  const sources = context.consumedSources?.privateConversationSources() ?? []
  const persistedSources = await persistablePrivateConversationSources(tx, sources)
  if (persistedSources.length === 0) return
  await tx.messageDisclosureSource.createMany({
    data: persistedSources.map((source) => ({
      messageId: input.messageId,
      organizationId: input.organizationId,
      sourceAuthorUserId: source.sourceAuthorUserId,
      sourceChannelId: source.sourceChannelId,
    })),
    skipDuplicates: true,
  })
}
