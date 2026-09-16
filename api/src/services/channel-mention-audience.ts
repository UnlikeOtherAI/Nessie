import type { PrismaClient } from '@prisma/client'
import { isOpenMentionChannel } from '@nessie/runtime'
import { isAdminActor, type AuthorizedActionContext } from '@nessie/schemas'
import { canModifyChannel } from '@nessie/team-admin'

/**
 * Before a draft that @mentions people is sent, the composer asks which of
 * them cannot read the channel, so the author can invite them in first
 * (`docs/standards/user-alerts.md` → "Who a mention can address").
 *
 * The answer is the server's, never the client's guess:
 *
 * - An **open** channel (public, not a DM, not a system conversation) has no
 *   outsiders — every active organisation member already reads it.
 * - A **DM** or **system** conversation has none either: its membership is
 *   fixed, so there is nobody to invite and today's behaviour stands.
 * - A **private or protected** channel's outsiders are the named people who
 *   are active members of the organisation and hold no `ChannelMember` row.
 *   An id that is not an active member is dropped silently — it is not
 *   addressable, and the answer must not confirm who exists.
 *
 * `viewerCanAddMembers` is `canModifyChannel`, the exact gate
 * `POST /api/channels/:channelId/members` applies, so the prompt never offers
 * an invite the write would refuse. Project membership plays no part: a
 * channel's readers are decided by its visibility and membership alone
 * (`getVisibleChannel`), and so is this.
 */
export type ChannelMentionAudience = {
  outsiderUserIds: string[]
  viewerCanAddMembers: boolean
}

export type ChannelMentionAudienceResult =
  | { kind: 'resolved'; audience: ChannelMentionAudience }
  | { kind: 'channel_not_found' }

export const resolveChannelMentionAudience = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: { channelId: string; userIds: string[] },
): Promise<ChannelMentionAudienceResult> => {
  const organizationId = actorContext.tenant.organizationId
  const actorId = actorContext.actor.actorId
  const channel = await prisma.channel.findFirst({
    where: { id: input.channelId, organizationId, deletedAt: null },
    select: {
      systemChannelType: true,
      type: true,
      visibility: true,
      members: {
        where: { userId: { in: [actorId, ...input.userIds] } },
        select: { userId: true },
      },
    },
  })
  if (!channel) return { kind: 'channel_not_found' }
  const memberIds = new Set(channel.members.map((member) => member.userId))
  // Somebody who cannot read the channel learns nothing about it.
  if (!memberIds.has(actorId) && channel.visibility !== 'public') {
    return { kind: 'channel_not_found' }
  }

  const none = { kind: 'resolved' as const, audience: { outsiderUserIds: [], viewerCanAddMembers: false } }
  if (
    channel.type === 'dm'
    || channel.systemChannelType
    || isOpenMentionChannel({ ...channel, organizationId })
  ) {
    return none
  }

  const candidateIds = input.userIds.filter((userId) => userId !== actorId && !memberIds.has(userId))
  if (candidateIds.length === 0) return none
  const active = await prisma.organizationMember.findMany({
    where: { organizationId, deactivatedAt: null, userId: { in: candidateIds } },
    select: { userId: true },
  })
  const activeIds = new Set(active.map((row) => row.userId))
  const outsiderUserIds = candidateIds.filter((userId) => activeIds.has(userId))
  if (outsiderUserIds.length === 0) return none

  const manage = await canModifyChannel(prisma, {
    channelId: input.channelId,
    isOrganizationAdmin: isAdminActor(actorContext),
    organizationId,
    userId: actorId,
  })
  return {
    kind: 'resolved',
    audience: { outsiderUserIds, viewerCanAddMembers: manage !== null },
  }
}
