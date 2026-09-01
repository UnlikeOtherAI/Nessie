import type { Prisma, PrismaClient } from '@prisma/client'

import { computeReplyBasis, type BasisScope } from '../execute/disclosure-basis.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'

type Tx = Prisma.TransactionClient | PrismaClient

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
