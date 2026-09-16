import type { Channel, PrismaClient } from '@prisma/client'
import { isAdminRole } from '@nessie/schemas'

import { isGroupDm } from './channel-records.js'
import { isProjectAccessibleToUser, type ProjectViewer } from './project-structure.js'

/**
 * Who may change a project or a channel: the one authorization decision every
 * route, service and assistant tool that renames, archives, deletes, manages
 * the members of, or reshapes (boards, columns, fields, sources, iterations,
 * watchers) a project or a channel asks.
 *
 * The model (`docs/standards/team-model.md` → "Who may change a project or a
 * channel"):
 *
 * 1. Any organisation member may create a project or a channel.
 * 2. Inside a project or a channel every member of it has equal rights. The
 *    creator is simply the first member; `ProjectMember.role` and
 *    `ChannelMember.role` grant nothing extra.
 * 3. Only an organisation owner or admin may change a project or channel they
 *    are not a member of. For a channel, the admin must be able to see it:
 *    any standard, non-system, non-group-DM channel (public or protected) is
 *    manageable by an organisation admin, who may also add themselves to a
 *    protected room. A direct message stays reachable only by its participants.
 *
 * Out of scope, and deliberately so: system channels (the Personal Assistant's
 * home, a global agent's home DM) are lifecycle-protected and refused for
 * everybody, and a direct message is reachable only by its participants, who
 * keep their own rule below.
 */

/**
 * A project's members, or an organisation owner or admin. `canModifyProject`
 * keeps its membership-or-org-admin definition: public projects may be readable
 * by any organisation member (`resolveProjectAccess`), but only members and
 * org admins may change boards, fields, sources, iterations and watchers.
 */
export const canModifyProject = async (
  prisma: PrismaClient,
  viewer: ProjectViewer,
  projectId: string,
): Promise<boolean> => isProjectAccessibleToUser(prisma, viewer, projectId)

export type ChannelModifier = {
  userId: string
  organizationId: string
  channelId: string
  /**
   * Organisation owner or admin, as the caller already verified it. A REST
   * request passes `isAdminActor(actorContext)`: `request-admission.ts` sets
   * those roles from UOA's live authorization for a bound organisation, so a
   * demotion or promotion upstream takes effect on the very next request. Left
   * undefined only by callers with no verified request role (the worker's
   * assistant tools), which fall back to the `OrganizationMember` row.
   */
  isOrganizationAdmin?: boolean
}

const resolveOrganizationAdmin = async (
  prisma: PrismaClient,
  input: Pick<ChannelModifier, 'isOrganizationAdmin' | 'organizationId' | 'userId'>,
): Promise<boolean> => {
  if (input.isOrganizationAdmin !== undefined) return input.isOrganizationAdmin
  const orgMember = await prisma.organizationMember.findFirst({
    where: { organizationId: input.organizationId, userId: input.userId },
    select: { role: true },
  })
  return isAdminRole(orgMember?.role)
}

/**
 * A channel's members, or an organisation owner or admin on a standard,
 * non-system, non-group-DM channel. The channel row comes back with the answer
 * so a caller that needs its scope — the rename's slug pre-check needs
 * `projectId` — does not read it twice.
 *
 * A team role is not an arm: rule 3 names the organisation owner or admin as
 * the only people who reach into a channel they are not in.
 */
export const canModifyChannel = async (
  prisma: PrismaClient,
  input: ChannelModifier,
): Promise<{ channel: Channel } | null> => {
  const channel = await prisma.channel.findUnique({
    where: { id: input.channelId },
  })
  // A soft-deleted channel is gone for every caller: nothing renames,
  // unarchives or re-members it until a restore exists.
  if (!channel || channel.organizationId !== input.organizationId || channel.deletedAt) {
    return null
  }

  // System channels are lifecycle-protected: their label, archive state and
  // membership are bootstrap-owned facts other rules depend on (a global
  // agent's home DM must stay reachable and single-member). Nobody changes one
  // by clicking or by asking; the ensure functions repair them instead.
  if (channel.systemChannelType) {
    return null
  }

  const [channelMember, isOrganizationAdmin] = await Promise.all([
    prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId: input.channelId, userId: input.userId } },
      select: { role: true },
    }),
    resolveOrganizationAdmin(prisma, input),
  ])

  // A direct message is somebody's private conversation: nobody outside it
  // reaches it, whatever their organisation or team role. Participation comes
  // first, so an organisation admin cannot rename or archive a DM they are not
  // in; only then does the legacy participant rule below apply.
  if (channel.type === 'dm') {
    if (!channelMember) return null
    if (isOrganizationAdmin) return { channel }
    const isManager = await isLegacyDmManager(prisma, {
      channel,
      channelRole: channelMember.role,
      userId: input.userId,
    })
    return isManager ? { channel } : null
  }

  if (channelMember) {
    return { channel }
  }

  // The organisation owner/admin arm reaches any standard, non-system,
  // non-group-DM channel they can see. A direct message stays reachable only by
  // its participants. Management is not participation: an admin may manage a
  // protected room without being a member, and may add themselves to it.
  return isOrganizationAdmin
    && channel.type === 'standard'
    && channel.systemChannelType === null
    && !isGroupDm(channel)
    ? { channel }
    : null
}

/**
 * A direct message is outside the equal-rights model: its membership is a fixed
 * pair the member routes refuse to change, and what a *participant* may do to it
 * is unchanged from the rule it had before — a channel or team owner/admin role
 * (an organisation owner or admin participant too, decided by the caller). Only
 * ever asked after participation is proven.
 */
const isLegacyDmManager = async (
  prisma: PrismaClient,
  input: { channel: Channel; channelRole: string | undefined; userId: string },
): Promise<boolean> => {
  if (isAdminRole(input.channelRole)) return true
  const teamMember = await prisma.teamMember.findFirst({
    where: { teamId: input.channel.teamId, userId: input.userId },
    select: { role: true },
  })
  return isAdminRole(teamMember?.role)
}
