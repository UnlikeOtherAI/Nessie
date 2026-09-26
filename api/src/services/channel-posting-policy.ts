import { Prisma, type PrismaClient } from '@prisma/client'
import { isAdminActor, type AuthorizedActionContext } from '@nessie/schemas'
import { isAnnouncementAdministrator } from '@nessie/team-admin'

export class ChannelPostForbiddenError extends Error {
  constructor(message = 'Only a channel administrator can post here') {
    super(message)
    this.name = 'ChannelPostForbiddenError'
  }
}

type PostingChannel = {
  id: string
  organizationId: string
  teamId: string
  type: string
  systemChannelType: string | null
  organization: { externalOrgId: string | null }
  team: { externalTeamId: string | null }
}

/** Resolve authority once from this request's live UOA admission or local mode. */
export const canAdminPostInChannel = async (
  prisma: PrismaClient,
  channel: PostingChannel,
  userId: string,
  actorContext: AuthorizedActionContext | undefined,
): Promise<boolean> => {
  if (actorContext?.actor.actorType !== 'user' || actorContext.actor.actorId !== userId
    || actorContext.tenant.organizationId !== channel.organizationId) return false
  const localTeamMember = channel.organization.externalOrgId
    ? null
    : await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: channel.teamId, userId } },
      select: { role: true },
    })
  return isAnnouncementAdministrator({
    channelType: channel.type,
    systemChannelType: channel.systemChannelType,
    isOrganizationAdmin: isAdminActor(actorContext),
    externalOrgId: channel.organization.externalOrgId,
    externalTeamId: channel.team.externalTeamId,
    uoaTeamRoles: actorContext.actionContext.uoaTeamRoles,
    localTeamRole: localTeamMember?.role,
  })
}

/**
 * Lock the channel row before every message insert. The database trigger takes
 * the same SHARE lock and accepts only this transaction's verified author.
 * Settings updates take an UPDATE lock, so a concurrent toggle orders before
 * or after the whole post rather than changing policy between check and write.
 */
export const prepareChannelMessageInsert = async (
  tx: Prisma.TransactionClient,
  input: { channelId: string; isVerifiedAdmin: boolean; isHumanComposerSend: boolean; userId: string },
): Promise<{ adminOnlyPosting: boolean; mandatoryAnnouncements: boolean }> => {
  const rows = await tx.$queryRaw<Array<{
    admin_only_posting: boolean
    mandatory_announcements: boolean
  }>>(Prisma.sql`
    SELECT admin_only_posting, mandatory_announcements
    FROM channels WHERE id = ${input.channelId}::uuid FOR SHARE
  `)
  const channel = rows[0]
  if (!channel) throw new ChannelPostForbiddenError('Channel no longer exists')
  if (channel.admin_only_posting && (!input.isVerifiedAdmin || !input.isHumanComposerSend)) {
    throw new ChannelPostForbiddenError()
  }
  if (channel.admin_only_posting) {
    await tx.$queryRaw(Prisma.sql`
      SELECT set_config('nessie.verified_channel_admin_user_id', ${input.userId}, TRUE)
    `)
  }
  return { adminOnlyPosting: channel.admin_only_posting,
    mandatoryAnnouncements: channel.mandatory_announcements }
}
