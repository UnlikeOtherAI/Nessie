import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { resolveChannelPolicyReplay } from '@nessie/team-admin'
import type { AccessibleRun } from './run-access.js'

/** Caller access is checked separately; custom policy work keeps its original authorizer. */
export const resolveRunReplayContext = async (
  prisma: PrismaClient,
  run: AccessibleRun,
  actorContext: AuthorizedActionContext,
): Promise<{ actorContext: AuthorizedActionContext; interactive: boolean }> => {
  const policy = await resolveChannelPolicyReplay(prisma, {
    snapshot: run.triggerMessageDecision, promptOverride: run.promptOverride,
    channelId: run.channelId, organizationId: actorContext.tenant.organizationId,
    messageId: run.triggerMessageId!,
    target: { agentId: run.agentId, principalUserId: run.principalUserId },
  })
  return policy
    ? { actorContext: policy.authorizer, interactive: false }
    : { actorContext, interactive: actorContext.actor.actorType === 'user' }
}
