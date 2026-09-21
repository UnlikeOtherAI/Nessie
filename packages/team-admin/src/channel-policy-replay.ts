import type { PrismaClient } from '@prisma/client'
import { canUserReadDisclosureBasis, type ResolveLiveEntitlementsDeps } from '@nessie/runtime'
import { ChannelDecisionSnapshotSchema, type AuthorizedActionContext } from '@nessie/schemas'
import { ChannelDecisionPolicyError, matchesChannelDecisionTarget } from './channel-decision-policy.js'
import { resolveChannelPolicyAuthorizer } from './channel-policy-authority.js'

/** A lifecycle action may replay saved work, but may never change who authorized it. */
export const resolveChannelPolicyReplay = async (
  prisma: PrismaClient,
  input: {
    snapshot: unknown
    channelId: string
    organizationId: string
    messageId: string
    target: { agentId: string; principalUserId?: string | null }
    promptOverride: string | null | undefined
  },
  deps: ResolveLiveEntitlementsDeps = {},
): Promise<{ authorizer: AuthorizedActionContext; promptOverride: string } | null> => {
  if (input.snapshot == null) return null
  const parsed = ChannelDecisionSnapshotSchema.safeParse(input.snapshot)
  if (!parsed.success) throw new ChannelDecisionPolicyError('The saved channel decision is invalid and cannot be replayed')
  const snapshot = parsed.data
  const targetReplies = snapshot.decisions.filter((decision) =>
    decision.action === 'reply' && matchesChannelDecisionTarget(input.target, decision))
  const replies = targetReplies.filter((decision) => decision.action === 'reply'
    && (decision.promptOverride ?? null) === (input.promptOverride ?? null))
  if (!replies.length) {
    throw new ChannelDecisionPolicyError('The saved channel decision no longer matches this run’s target and instructions')
  }
  if (replies.length > 1) throw new ChannelDecisionPolicyError('The saved channel decision has ambiguous work for this agent')
  const decision = replies[0]
  if (!decision || decision.action !== 'reply' || !decision.policyWork) return null
  if (!decision.promptOverride) {
    throw new ChannelDecisionPolicyError('The saved policy work no longer matches this run’s instructions')
  }
  const authorizer = await resolveChannelPolicyAuthorizer(prisma, {
    authorizer: snapshot.authorizer,
    channelId: input.channelId, organizationId: input.organizationId, target: input.target,
  }, deps)
  const basis = [...snapshot.basisScopes, ...snapshot.disclosureSources.map((source) => ({
    scopeType: 'channel', scopeId: source.sourceChannelId,
  }))]
  if (basis.length && !await canUserReadDisclosureBasis(prisma, {
    agentId: input.target.agentId, basis, channelId: input.channelId,
    disclosureSources: snapshot.disclosureSources, messageId: input.messageId,
    organizationId: input.organizationId, userId: authorizer.actor.actorId,
    uoaIdentity: authorizer.actionContext.uoaIdentity,
  })) {
    throw new ChannelDecisionPolicyError('The policy authorizer can no longer read the sources for this decision')
  }
  return { authorizer, promptOverride: decision.promptOverride }
}
