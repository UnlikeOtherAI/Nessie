import type { ChannelSystemType, PrismaClient } from '@prisma/client'
import { buildAgentVisibilityWhere, buildVisibleAgentWhere } from '@nessie/db'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { resolveLiveEntitlements, type LiveEntitlements } from './uoa-live-entitlements.js'

export type ChannelAccessRow = {
  systemChannelType?: ChannelSystemType
  type: string
  visibility: string
}

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
  if (!channel || channel.organizationId !== organizationId || channel.members.length === 0) {
    return null
  }
  return {
    systemChannelType: channel.systemChannelType ?? undefined,
    type: channel.type,
    visibility: channel.visibility,
  }
}

export const isAgentVisibleToUser = async (
  prisma: PrismaClient,
  userId: string,
  organizationId: string,
  agentId: string,
  uoaMembershipVerified = false,
): Promise<boolean> =>
  (await prisma.agent.count({
    where: {
      AND: [buildVisibleAgentWhere({ organizationId, userId, uoaMembershipVerified })],
      id: agentId,
    },
  })) > 0

/** The one agent reachability predicate shared by edit authority and surfaces. */
export const isAgentAccessibleToActor = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  agentId: string,
  verifiedEntitlements?: LiveEntitlements,
): Promise<boolean> => {
  const entitlements = verifiedEntitlements ?? await resolveLiveEntitlements(prisma, {
    organizationId: actorContext.tenant.organizationId,
    uoaIdentity: actorContext.actionContext.uoaIdentity,
    userId: actorContext.actor.actorId,
  })
  if (
    entitlements.kind === 'denied'
    || entitlements.organizationId !== actorContext.tenant.organizationId
    || entitlements.userId !== actorContext.actor.actorId
  ) return false
  const isOwner = entitlements.kind === 'uoa'
    ? entitlements.organizationRole === 'owner'
    : actorContext.actor.roles?.includes('owner') === true
  if (isOwner) {
    return (await prisma.agent.count({
      where: {
        AND: [buildAgentVisibilityWhere({
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
          uoaMembershipVerified: entitlements.kind === 'uoa',
        })],
        id: agentId,
        organizationId: actorContext.tenant.organizationId,
        systemManaged: false,
      },
    })) > 0
  }
  return isAgentVisibleToUser(
    prisma,
    actorContext.actor.actorId,
    actorContext.tenant.organizationId,
    agentId,
    entitlements.kind === 'uoa',
  )
}
