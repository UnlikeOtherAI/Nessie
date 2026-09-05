import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { canManageChannel, loadChannelTeamProject } from '@nessie/team-admin'

import { emitAuditEvent } from './audit.js'

/**
 * Changing who is in a channel is a disclosure decision, so it takes the same
 * gate renaming and archiving take: `canManageChannel` (channel owner/admin,
 * team owner/admin, organisation owner/admin). Membership was previously open
 * to any member of the channel, which meant the weaker act (renaming) was
 * guarded harder than the stronger one (handing a stranger a private channel's
 * whole history, or evicting the channel's own owner).
 *
 * The decision lives here rather than in the route because the same rule has to
 * hold for every caller of these two writes, and because the audit row that
 * records it belongs beside the mutation.
 */
export type ChannelMemberChange =
  | { kind: 'changed' }
  | { kind: 'channel_not_found' }
  | { kind: 'system_managed' }
  | { kind: 'dm_members_fixed' }
  | { kind: 'forbidden' }
  | { kind: 'target_not_in_organization' }

type MemberChangeChannel = {
  // Whether the actor holds a `ChannelMember` row — what makes leaving legal.
  actorIsMember: boolean
  // Whether the actor can see the channel at all. A refusal to somebody who
  // cannot is a 404, so a private channel's existence is not disclosed by the
  // status code.
  actorCanSee: boolean
  systemChannelType: string | null
  type: string
}

const loadChannelForMemberChange = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  channelId: string,
): Promise<MemberChangeChannel | null> => {
  const channel = await prisma.channel.findFirst({
    where: { id: channelId, organizationId: actorContext.tenant.organizationId },
    select: {
      systemChannelType: true,
      type: true,
      visibility: true,
      members: {
        where: { userId: actorContext.actor.actorId },
        select: { id: true },
        take: 1,
      },
    },
  })
  if (!channel) return null
  const actorIsMember = channel.members.length > 0
  return {
    actorIsMember,
    actorCanSee: actorIsMember || channel.visibility === 'public',
    systemChannelType: channel.systemChannelType,
    type: channel.type,
  }
}

// The refusals both membership writes share, in the order the surface states
// them: unreachable channel, bootstrap-owned system conversation, fixed DM pair.
const resolveChannelForMemberChange = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  channelId: string,
): Promise<{ refusal: ChannelMemberChange } | { channel: MemberChangeChannel }> => {
  const channel = await loadChannelForMemberChange(prisma, actorContext, channelId)
  if (!channel) return { refusal: { kind: 'channel_not_found' } }
  if (channel.systemChannelType) return { refusal: { kind: 'system_managed' } }
  if (channel.type === 'dm') return { refusal: { kind: 'dm_members_fixed' } }
  return { channel }
}

const refuseUnlessManager = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  channelId: string,
  channel: MemberChangeChannel,
): Promise<ChannelMemberChange | null> => {
  const manage = await canManageChannel(prisma, {
    channelId,
    organizationId: actorContext.tenant.organizationId,
    userId: actorContext.actor.actorId,
  })
  if (manage) return null
  return channel.actorCanSee
    ? { kind: 'forbidden' }
    : { kind: 'channel_not_found' }
}

export const addMemberToChannel = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: { channelId: string; userId: string },
): Promise<ChannelMemberChange> => {
  const resolved = await resolveChannelForMemberChange(prisma, actorContext, input.channelId)
  if ('refusal' in resolved) return resolved.refusal

  const refusal = await refuseUnlessManager(
    prisma,
    actorContext,
    input.channelId,
    resolved.channel,
  )
  if (refusal) return refusal

  // The channel is already proven to be in this organisation, so the target is
  // checked against the same one: a cross-org user can never be added.
  const isOrgMember = await prisma.organizationMember.count({
    where: { organizationId: actorContext.tenant.organizationId, userId: input.userId },
  })
  if (!isOrgMember) return { kind: 'target_not_in_organization' }

  await prisma.channelMember.upsert({
    where: { channelId_userId: { channelId: input.channelId, userId: input.userId } },
    create: { channelId: input.channelId, userId: input.userId },
    update: {},
  })
  await emitAuditEvent(prisma, {
    actorContext,
    action: 'channel.member_added',
    resourceId: input.channelId,
    resourceType: 'channel',
    outcome: 'success',
    metadata: { memberUserId: input.userId },
  })
  return { kind: 'changed' }
}

export const removeMemberFromChannel = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: { channelId: string; userId: string },
): Promise<ChannelMemberChange> => {
  const resolved = await resolveChannelForMemberChange(prisma, actorContext, input.channelId)
  if ('refusal' in resolved) return resolved.refusal

  // Leaving is not managing. A person may always take themselves out of a
  // channel they are in, which is the one membership write that needs no
  // authority over the channel.
  const isLeaving = input.userId === actorContext.actor.actorId
  if (isLeaving) {
    if (!resolved.channel.actorIsMember) return { kind: 'channel_not_found' }
  } else {
    const refusal = await refuseUnlessManager(
      prisma,
      actorContext,
      input.channelId,
      resolved.channel,
    )
    if (refusal) return refusal
  }

  await prisma.channelMember.deleteMany({
    where: { channelId: input.channelId, userId: input.userId },
  })
  await emitAuditEvent(prisma, {
    actorContext,
    action: 'channel.member_removed',
    resourceId: input.channelId,
    resourceType: 'channel',
    outcome: 'success',
    metadata: { left: isLeaving, memberUserId: input.userId },
  })
  return { kind: 'changed' }
}

export const validateTenantHierarchy = async (
  prisma: PrismaClient,
  organizationId: string,
  teamId: string,
): Promise<boolean> =>
  (await loadChannelTeamProject(prisma, { organizationId, teamId })) !== null
