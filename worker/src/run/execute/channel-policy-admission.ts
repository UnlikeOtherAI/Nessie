import type { PrismaClient } from '@prisma/client'
import { viewerSatisfiesBasis } from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'
import { ChannelDecisionPolicyError, resolveChannelPolicyAuthorizer } from '@nessie/team-admin'
import { resolveDisclosureViewer } from './disclosure-viewer.js'
import type { RunContext } from './types.js'
import { isWordless } from './working-marker.js'

/**
 * Configured policy work that ends with nothing to report posts nothing.
 *
 * Background work is told to answer with a bare mark when nothing about it
 * needs to reach anyone (`POLICY_WORK_QUIET_MARK` in `decideChannelActions`) —
 * not with silence, because an empty answer is what a failed provider looks
 * like and the loop asks again. A run acting under a channel policy's
 * authority whose answer has no letter or digit in it is that mark, so the
 * completion path delivers nothing; a result, a failure or a required action
 * is written in words and posted as ever. Structural on both sides: who the run
 * acts as, and whether the answer says anything at all — never what it means.
 */
export const concludesQuietly = (payload: RunExecuteJobPayload, responseText: string): boolean =>
  payload.actorContext.actionContext.purpose === 'channel.policy' && isWordless(responseText)

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
