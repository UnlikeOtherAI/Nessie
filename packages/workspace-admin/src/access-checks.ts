import type { ChannelSystemType, PrismaClient } from '@prisma/client'
import { buildVisibleAgentWhere } from '@nessie/db'
import type { AuthorizedActionContext } from '@nessie/schemas'

export type ChannelAccessRow = {
  systemChannelType?: ChannelSystemType
  type: string
  visibility: string
}

/**
 * The two visibility predicates the agent/binding/trigger routes gate on,
 * shared with the personal assistant's provisioning tools so "can this person
 * see this channel/agent" has one answer regardless of which surface asks.
 */

/**
 * Membership, not visibility: binding an agent to a channel requires the caller
 * to be IN that channel, so a public channel they never joined is not enough.
 */
export const getChannelIfMember = async (
  prisma: PrismaClient,
  userId: string,
  organizationId: string,
  channelId: string,
): Promise<ChannelAccessRow | null> => {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      systemChannelType: true,
      type: true,
      organizationId: true,
      visibility: true,
      members: { where: { userId }, select: { id: true }, take: 1 },
    },
  })
  if (!channel) return null
  if (channel.organizationId !== organizationId) return null
  if (channel.members.length === 0) return null
  return {
    systemChannelType: channel.systemChannelType ?? undefined,
    type: channel.type,
    visibility: channel.visibility,
  }
}

/**
 * An agent is visible to a user through any channel that user can see it bound
 * to — or because that user stewards it. Both this per-agent gate and the list
 * compose `@nessie/db`'s one fragment, so derived access (including agent
 * documents) cannot drift from the owning surface.
 */
export const isAgentVisibleToUser = async (
  prisma: PrismaClient,
  userId: string,
  organizationId: string,
  agentId: string,
): Promise<boolean> =>
  (await prisma.agent.count({
    where: {
      ...buildVisibleAgentWhere({ organizationId, userId }),
      id: agentId,
    },
  })) > 0

/**
 * An owner reaches every non-system agent in the organization, including
 * unbound ones; everybody else reaches an agent only through a channel they can
 * see it working in.
 */
export const isAgentAccessibleToActor = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  agentId: string,
): Promise<boolean> => {
  if (actorContext.actor.roles?.includes('owner')) {
    return (
      await prisma.agent.count({
        where: {
          id: agentId,
          organizationId: actorContext.tenant.organizationId,
          systemManaged: false,
        },
      })
    ) > 0
  }

  return isAgentVisibleToUser(
    prisma,
    actorContext.actor.actorId,
    actorContext.tenant.organizationId,
    agentId,
  )
}
