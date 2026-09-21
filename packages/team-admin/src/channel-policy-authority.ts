import type { PrismaClient } from '@prisma/client'
import {
  activeTeamMatchesAttribution,
  resolveLiveEntitlementDecision,
  type ResolveLiveEntitlementsDeps,
} from '@nessie/runtime'
import {
  AuthorizedActionContextSchema,
  isAdminRole,
  UserIdSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { ChannelDecisionPolicyError } from './channel-decision-policy.js'
import { canModifyChannel } from './resource-authority.js'

type PolicyScope = { channelId: string; organizationId: string }

/** Capture references from the authenticated writer, never from a policy body. */
export const captureChannelPolicyAuthorizer = (
  context: AuthorizedActionContext | undefined,
  input: PolicyScope & { userId: string },
): AuthorizedActionContext => {
  if (!context
    || context.actor.actorType !== 'user'
    || context.actor.actorId !== input.userId
    || context.tenant.organizationId !== input.organizationId
    || (context.actionContext.effectiveUserId && context.actionContext.effectiveUserId !== input.userId)) {
    throw new ChannelDecisionPolicyError('Saving a decision policy requires its authenticated human authorizer')
  }
  // Preserve the authenticated team exactly like a schedule's launch origin.
  // Transient session, approval and verification proofs are never standing grants.
  const teamId = context.tenant.teamId ?? context.actionContext.teamId
  return AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: input.userId },
    tenant: {
      organizationId: context.tenant.organizationId,
      ...(context.tenant.projectId ? { projectId: context.tenant.projectId } : {}),
      ...(teamId ? { teamId } : {}),
    },
    actionContext: {
      channelId: input.channelId,
      effectiveUserId: input.userId,
      purpose: 'channel.policy',
      requestId: context.actionContext.requestId,
      ...(teamId ? { teamId } : {}),
      ...(context.actionContext.uoaIdentity ? { uoaIdentity: context.actionContext.uoaIdentity } : {}),
    },
  })
}

/** Rechecked at dispatch AND run start, including pending drains and restarts. */
export const resolveChannelPolicyAuthorizer = async (
  prisma: PrismaClient,
  input: PolicyScope & {
    authorizer: unknown
    target?: { agentId: string; principalUserId?: string | null }
  },
  deps: ResolveLiveEntitlementsDeps = {},
): Promise<AuthorizedActionContext> => {
  const parsed = AuthorizedActionContextSchema.safeParse(input.authorizer)
  if (!parsed.success) throw new ChannelDecisionPolicyError('The decision policy needs to be saved again to authorize work')
  const context = parsed.data
  const userId = UserIdSchema.safeParse(context.actor.actorId)
  if (!userId.success
    || context.actor.actorType !== 'user'
    || context.tenant.organizationId !== input.organizationId
    || context.actionContext.channelId !== input.channelId
    || context.actionContext.effectiveUserId !== context.actor.actorId
    || context.actionContext.purpose !== 'channel.policy') {
    throw new ChannelDecisionPolicyError('The saved decision policy authorizer does not match this channel')
  }
  const decision = await resolveLiveEntitlementDecision(prisma, {
    organizationId: input.organizationId,
    uoaIdentity: context.actionContext.uoaIdentity,
    userId: userId.data,
  }, deps)
  if (decision.status !== 'allowed') {
    throw new ChannelDecisionPolicyError(decision.status === 'unavailable'
      ? 'The decision policy authorizer cannot be verified while UnlikeOtherAI is unavailable'
      : 'The decision policy authorizer has lost access; sign in and save the policy again')
  }
  const entitlements = decision.entitlements
  const membership = entitlements.kind === 'local' ? await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: input.organizationId, userId: userId.data } },
    select: { role: true, deactivatedAt: true },
  }) : null
  if (entitlements.kind === 'local' && (!membership || membership.deactivatedAt)) {
    throw new ChannelDecisionPolicyError('The decision policy authorizer is no longer an active organisation member')
  }
  const role = entitlements.kind === 'uoa' ? entitlements.organizationRole : membership!.role
  if (entitlements.kind === 'uoa') {
    const identity = context.actionContext.uoaIdentity
    const teamId = context.tenant.teamId
    if (!identity || identity.tokenVersion === null || !teamId || !entitlements.teamIds.includes(teamId)
      || !await activeTeamMatchesAttribution(prisma, {
        actorId: userId.data, actorType: 'user', organizationId: input.organizationId, teamId,
      }, { ...identity, tokenVersion: identity.tokenVersion })) {
      throw new ChannelDecisionPolicyError('The decision policy authorizer has lost its authenticated team scope')
    }
  }
  const manageable = await canModifyChannel(prisma, {
    ...input, userId: userId.data, isOrganizationAdmin: isAdminRole(role),
  })
  if (!manageable || manageable.channel.type !== 'standard' || manageable.channel.archivedAt) {
    throw new ChannelDecisionPolicyError('The decision policy authorizer can no longer manage this active channel')
  }
  if (input.target) {
    if (manageable.channel.visibility !== 'public' && !await prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId: input.channelId, userId: userId.data } },
      select: { id: true },
    })) {
      throw new ChannelDecisionPolicyError('The decision policy authorizer cannot read this channel; join it first')
    }
    const principalUserId = input.target.principalUserId ?? null
    if (principalUserId && principalUserId !== userId.data) {
      throw new ChannelDecisionPolicyError('A decision policy cannot act as another person’s Personal Assistant')
    }
    const binding = await prisma.agentBinding.findFirst({
      where: {
        agentId: input.target.agentId, channelId: input.channelId, principalUserId,
        agent: { organizationId: input.organizationId, visibility: { not: 'private' } },
      },
      select: { id: true },
    })
    if (!binding) throw new ChannelDecisionPolicyError('The decision policy agent is no longer in this channel')
  }
  // Preserve fresh per-run/thread/task fields supplied by dispatch or resume.
  return { ...context, actor: { ...context.actor, roles: [role] } }
}
