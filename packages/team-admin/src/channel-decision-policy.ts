import type { Prisma } from '@prisma/client'
import { ChannelDecisionPolicySchema, type ChannelDecisionPolicy } from '@nessie/schemas'

export class ChannelDecisionPolicyError extends Error {
  override readonly name = 'ChannelDecisionPolicyError'
}

export const matchesChannelDecisionTarget = (
  target: { agentId: string; principalUserId?: string | null },
  binding: { agentId: string; principalUserId?: string | null },
): boolean => target.agentId === binding.agentId
  && (target.principalUserId ?? null) === (binding.principalUserId ?? null)

/** A policy can route work only to an existing, exactly identified participant. */
export const validateChannelDecisionPolicy = async (
  prisma: Pick<Prisma.TransactionClient, 'agentBinding'>,
  input: { policy: unknown; channelId: string; organizationId: string; userId: string },
): Promise<ChannelDecisionPolicy | null> => {
  if (input.policy === null) return null
  const parsed = ChannelDecisionPolicySchema.safeParse(input.policy)
  if (!parsed.success) {
    throw new ChannelDecisionPolicyError(parsed.error.issues.map((issue) => issue.message).join('; '))
  }
  const policy = parsed.data
  const targets = policy.questions.flatMap((question) =>
    question.options.flatMap((option) => option.followUp ? [option.followUp] : []))
  if (targets.length === 0) return policy

  // A channel policy never delegates another person's PA authority. A matching
  // channel binding is still required for the requester's own PA presence.
  if (targets.some((target) => target.principalUserId && target.principalUserId !== input.userId)) {
    throw new ChannelDecisionPolicyError('A follow-up may use only your own Personal Assistant presence')
  }
  const bindings = await prisma.agentBinding.findMany({
    where: {
      channelId: input.channelId,
      agentId: { in: [...new Set(targets.map((target) => target.agentId))] },
      agent: { organizationId: input.organizationId, visibility: { not: 'private' } },
    },
    select: { agentId: true, principalUserId: true },
  })
  if (targets.some((target) => !bindings.some((binding) => matchesChannelDecisionTarget(target, binding)))) {
    throw new ChannelDecisionPolicyError('Every follow-up agent must already be a participant in this channel')
  }
  return policy
}
