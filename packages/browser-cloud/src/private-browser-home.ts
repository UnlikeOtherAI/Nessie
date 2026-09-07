import type { Prisma, PrismaClient } from '@prisma/client'

/**
 * The only home surfaces that can carry a person's temporary browser state.
 *
 * A non-null AgentBinding principal is a Personal Assistant presence, not a
 * private-home marker. Home bindings are deliberately principal-null and the
 * channel's canonical key, sole membership, and binding prove the audience.
 */
export type PrivateBrowserHomeDatabase = Pick<
  PrismaClient,
  'agent' | 'agentBinding' | 'channelMember' | 'organizationMember' | 'thread'
>

export type PrivateBrowserHome = {
  agentId: string
  organizationId: string
  threadId: string
  userId: string
}

const ordinaryHomeKey = (input: PrivateBrowserHome): string =>
  `agent:${input.organizationId}:${input.userId}:${input.agentId}`

const personalAssistantHomeKey = (input: PrivateBrowserHome): string =>
  `pa:${input.organizationId}:${input.userId}`

const globalAgentHomeKey = (input: PrivateBrowserHome, slug: string): string =>
  `gagent:${slug}:${input.organizationId}:${input.userId}`

/**
 * Rechecks live membership and the canonical one-person home at each personal
 * browser boundary. Shared DMs, PA presences, and team channels fail closed.
 */
export const isPrivateBrowserHome = async (
  prisma: PrivateBrowserHomeDatabase | Prisma.TransactionClient,
  input: PrivateBrowserHome,
): Promise<boolean> => {
  const [membership, thread, identity] = await Promise.all([
    prisma.organizationMember.count({
      where: {
        deactivatedAt: null,
        organizationId: input.organizationId,
        userId: input.userId,
      },
    }),
    prisma.thread.findFirst({
      where: { id: input.threadId, channel: { organizationId: input.organizationId } },
      select: {
        channel: {
          select: {
            dmKey: true,
            id: true,
            systemChannelType: true,
            type: true,
            visibility: true,
            _count: { select: { members: true } },
          },
        },
      },
    }),
    prisma.agent.findFirst({
      where: { id: input.agentId, organizationId: input.organizationId },
      select: { agentKind: true, ownerUserId: true, systemManaged: true, systemSlug: true, visibility: true },
    }),
  ])
  if (membership !== 1 || !thread || thread.channel.type !== 'dm'
    || thread.channel.visibility !== 'private' || thread.channel._count.members !== 1) return false

  const [member, binding] = await Promise.all([
    prisma.channelMember.count({ where: { channelId: thread.channel.id, userId: input.userId } }),
    prisma.agentBinding.count({
      where: { agentId: input.agentId, channelId: thread.channel.id, principalUserId: null },
    }),
  ])
  if (member !== 1 || binding !== 1) return false


  if (!identity) return false
  const channel = thread.channel
  if (identity.visibility === 'private' && identity.ownerUserId === input.userId) {
    return channel.systemChannelType === null && channel.dmKey === ordinaryHomeKey(input)
  }
  if (identity.agentKind === 'personal_assistant') {
    return channel.systemChannelType === 'personal_assistant'
      && channel.dmKey === personalAssistantHomeKey(input)
  }
  return identity.systemManaged && identity.systemSlug !== null
    && channel.systemChannelType === 'system_agent'
    && channel.dmKey === globalAgentHomeKey(input, identity.systemSlug)
}
