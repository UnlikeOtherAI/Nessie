import type { PrismaClient } from '@prisma/client'
import { viewerSatisfiesBasis } from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'
import { ChannelDecisionPolicyError, resolveChannelPolicyAuthorizer } from '@nessie/team-admin'
import { resolveDisclosureViewer } from './disclosure-viewer.js'
import type { RunContext } from './types.js'

/** Recheck queued policy work before any provider sees its saved input. */
export const revalidateChannelPolicyRun = async (
  prisma: PrismaClient,
  payload: RunExecuteJobPayload,
  context: Pick<RunContext, 'channel' | 'consumedSources'>,
): Promise<RunExecuteJobPayload> => {
  if (payload.actorContext.actionContext.purpose !== 'channel.policy') return payload
  const actorContext = await resolveChannelPolicyAuthorizer(prisma, {
    authorizer: payload.actorContext,
    channelId: context.channel.id,
    organizationId: context.channel.organizationId,
    target: { agentId: payload.agentId, principalUserId: payload.principalUserId },
  })
  const authorizedPayload = { ...payload, actorContext }
  const viewer = await resolveDisclosureViewer(prisma, authorizedPayload, context.channel.organizationId)
  if (!viewerSatisfiesBasis(context.consumedSources.list(), viewer)) {
    throw new ChannelDecisionPolicyError('The decision policy authorizer can no longer read its saved context')
  }
  return authorizedPayload
}
