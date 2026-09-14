import type { Channel, PrismaClient } from '@prisma/client'
import { isAdminRole } from '@nessie/schemas'

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
 *    are not a member of.
 *
 * Out of scope, and deliberately so: system channels (the Personal Assistant's
 * home, a global agent's home DM) are lifecycle-protected and refused for
 * everybody, and a direct message keeps its own participant rule below.
 */

/**
 * A project's members, or an organisation owner or admin. Project read and
 * modify entitlement coincide under the model — whoever can open a project can
 * change it — so this asks exactly the question `isProjectAccessibleToUser`
 * answers, and the two can never drift apart.
 */
export const canModifyProject = async (
  prisma: PrismaClient,
  viewer: ProjectViewer,
  projectId: string,
): Promise<boolean> => isProjectAccessibleToUser(prisma, viewer, projectId)

/**
 * A channel's members, or an organisation owner or admin. The channel row comes
 * back with the answer so a caller that needs its scope — the rename's slug
 * pre-check needs `projectId` — does not read it twice.
 *
 * A team role is not an arm: rule 3 names the organisation owner or admin as
 * the only people who reach into a channel they are not in.
 */
export const canModifyChannel = async (
  prisma: PrismaClient,
  input: { userId: string; organizationId: string; channelId: string },
): Promise<{ channel: Channel } | null> => {
  const channel = await prisma.channel.findUnique({
    where: { id: input.channelId },
  })
  if (!channel || channel.organizationId !== input.organizationId) {
    return null
  }

  // System channels are lifecycle-protected: their label, archive state and
  // membership are bootstrap-owned facts other rules depend on (a global
  // agent's home DM must stay reachable and single-member). Nobody changes one
  // by clicking or by asking; the ensure functions repair them instead.
  if (channel.systemChannelType) {
    return null
  }

  const [channelMember, orgMember] = await Promise.all([
    prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId: input.channelId, userId: input.userId } },
      select: { role: true },
    }),
    prisma.organizationMember.findFirst({
      where: { organizationId: input.organizationId, userId: input.userId },
      select: { role: true },
    }),
  ])

  if (isAdminRole(orgMember?.role)) {
    return { channel }
  }

  if (channel.type === 'dm') {
    const isManager = await isLegacyDmManager(prisma, {
      channel,
      channelRole: channelMember?.role,
      userId: input.userId,
    })
    return isManager ? { channel } : null
  }

  return channelMember ? { channel } : null
}

/**
 * A direct message is outside the equal-rights model: its membership is a fixed
 * pair the member routes refuse to change, and what a participant may do to it
 * is unchanged from the rule it had before — a channel or team owner/admin role.
 * Kept here so the one predicate still answers for every channel type.
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
