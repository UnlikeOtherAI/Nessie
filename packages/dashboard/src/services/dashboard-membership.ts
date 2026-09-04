/**
 * Membership adapter for the dashboard access resolver.
 *
 * `@nessie/dashboard` deliberately takes these predicates as an injected
 * dependency rather than importing them: the package is consumed by the worker
 * too, and forking channel/project/team membership rules into it would be a
 * second implementation of an authorization decision — the exact defect Rule
 * zero §4 names. This module is the one place they are bound to Prisma.
 *
 * Every predicate reads live rows. An actor's role and memberships are
 * re-resolved per call, never taken from a session claim or a run's
 * enqueue-time snapshot, so revocation takes effect on the next read.
 */

import type { Prisma, PrismaClient } from '@prisma/client'
import type { DashboardActor, DashboardMembership } from '../index.js'

export const createDashboardMembership = (
  prisma: PrismaClient | Prisma.TransactionClient,
): DashboardMembership => ({
  isProjectMember: async (userId, projectId) =>
    (await prisma.projectMember.count({ where: { userId, projectId } })) > 0,

  isTeamMember: async (userId, teamId) =>
    (await prisma.teamMember.count({ where: { userId, teamId } })) > 0,

  isChannelMember: async (userId, channelId) =>
    (await prisma.channelMember.count({ where: { userId, channelId } })) > 0,

  /**
   * A message is readable when its container is. Resolved through the channel
   * the thread belongs to, so a widget quoted into a channel the viewer left
   * stops resolving the moment they leave.
   */
  canReadMessage: async (userId, messageId) => {
    const message = await prisma.message.findFirst({
      where: { id: messageId, deletedAt: null },
      select: { thread: { select: { channelId: true } } },
    })
    const channelId = message?.thread?.channelId
    if (!channelId) return false
    return (await prisma.channelMember.count({ where: { userId, channelId } })) > 0
  },

  /**
   * A knowledge page version is readable when its page's project is. Page-level
   * privacy (privateToAgentId) is checked too: an agent-private page must not
   * become readable because a widget was embedded in it.
   */
  canReadKnowledgePageVersion: async (userId, versionId) => {
    const version = await prisma.knowledgePageVersion.findFirst({
      where: { id: versionId },
      select: {
        page: {
          select: { projectId: true, deletedAt: true, privateToAgentId: true },
        },
      },
    })
    const page = version?.page
    if (!page || page.deletedAt || page.privateToAgentId) return false
    return (await prisma.projectMember.count({ where: { userId, projectId: page.projectId } })) > 0
  },

  /**
   * The principals a grant may name to reach this actor: the user themselves,
   * the agent when a run is acting, and every audience they currently belong
   * to. Audience grants therefore follow membership without a backfill — being
   * removed from a channel revokes a channel grant on the next read.
   */
  subjectsForActor: async (actor: DashboardActor) => {
    const [projects, teams, channels] = await Promise.all([
      prisma.projectMember.findMany({
        where: { userId: actor.userId },
        select: { projectId: true },
      }),
      prisma.teamMember.findMany({ where: { userId: actor.userId }, select: { teamId: true } }),
      prisma.channelMember.findMany({
        where: { userId: actor.userId },
        select: { channelId: true },
      }),
    ])

    const subjects = [
      { type: 'user', id: actor.userId },
      ...projects.map((row) => ({ type: 'project', id: row.projectId })),
      ...teams.map((row) => ({ type: 'team', id: row.teamId })),
      ...channels.map((row) => ({ type: 'channel', id: row.channelId })),
    ]
    if (actor.agentId) subjects.push({ type: 'agent', id: actor.agentId })
    return subjects
  },
})

/**
 * Resolves the acting member from the live OrganizationMember row.
 *
 * Returns null for a deactivated membership: a run enqueued while someone was
 * active must not keep acting after they are deactivated, which is the same
 * rule the PA provisioning tools and the scheduled-trigger poller enforce.
 */
export const resolveDashboardActor = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string; agentId?: string },
): Promise<DashboardActor | null> => {
  const member = await prisma.organizationMember.findFirst({
    where: {
      organizationId: input.organizationId,
      userId: input.userId,
      deactivatedAt: null,
    },
    select: { role: true },
  })
  if (!member) return null

  const role = member.role === 'owner' || member.role === 'admin' ? member.role : 'member'
  return {
    userId: input.userId,
    organizationId: input.organizationId,
    role,
    ...(input.agentId ? { agentId: input.agentId } : {}),
  }
}
