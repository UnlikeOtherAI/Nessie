import { Prisma, type PrismaClient } from '@prisma/client'
import type { ChannelRecord } from '@nessie/schemas'

import { isAdminRole } from '@nessie/schemas'

import { channelTeamInclude, mapChannelRecord } from './channel-records.js'
import { canModifyProject } from './resource-authority.js'
import {
  ensureChannelSlugAvailable,
  loadChannelTeamProject,
  throwIfChannelSlugConflict,
  validateChannelLabel,
} from './channel-slugs.js'

const STANDALONE_CHANNEL_PROJECT_NAME = 'Standalone channels'
const STANDALONE_CHANNEL_TEAM_NAME = 'Standalone channels'

/**
 * The caller named a team they have no standing in. Thrown rather than folded
 * into the `null` return, which already means "that team is not in this
 * organisation" — a refusal and a hierarchy violation are different answers and
 * the route owes them different statuses.
 */
export class ChannelTeamAccessError extends Error {}

/**
 * May this person place a channel in this team?
 *
 * A team is the unit people are members of, so an organisation membership is
 * not enough: without this, any member could drop a channel into a team they
 * are not in by naming its id in the request body. The arms, in the order they
 * are cheapest to justify:
 *
 * - a `systemManaged` team (the standalone channel root, the Personal
 *   Assistant's team) has no members by construction — it is one of the two
 *   exceptions `docs/standards/team-model.md` names, and the channels that land
 *   in it are system surfaces, not somebody else's team's rooms;
 * - a `TeamMember` row, the projection of UOA's own membership;
 * - a `ProjectMember` row on the team's project, which is how somebody working
 *   a project reaches its rooms;
 * - an organisation owner or admin.
 */
const canPlaceChannelInTeam = async (
  prisma: PrismaClient,
  input: {
    isOrganizationAdmin: boolean
    organizationId: string
    projectId: string
    teamId: string
    userId: string
  },
): Promise<boolean> => {
  const [team, teamMember, projectMember] = await Promise.all([
    prisma.team.findUnique({
      where: { id: input.teamId },
      select: { systemManaged: true },
    }),
    prisma.teamMember.findFirst({
      where: { teamId: input.teamId, userId: input.userId },
      select: { id: true },
    }),
    prisma.projectMember.findFirst({
      where: { projectId: input.projectId, userId: input.userId },
      select: { id: true },
    }),
  ])
  return (
    team?.systemManaged === true
    || teamMember !== null
    || projectMember !== null
    || input.isOrganizationAdmin
  )
}

/**
 * The caller's verified organisation owner/admin standing when it has one
 * (`isAdminActor` on a REST request), otherwise the `OrganizationMember` row.
 */
const resolveOrganizationAdmin = async (
  prisma: PrismaClient,
  input: { isOrganizationAdmin?: boolean; organizationId: string; userId: string },
): Promise<boolean> => {
  if (input.isOrganizationAdmin !== undefined) return input.isOrganizationAdmin
  const orgMember = await prisma.organizationMember.findFirst({
    where: { organizationId: input.organizationId, userId: input.userId },
    select: { role: true },
  })
  return isAdminRole(orgMember?.role)
}

export class ChannelProjectAccessError extends ChannelTeamAccessError {}

const ensureStandaloneChannelTeam = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<{ projectId: string; teamId: string }> =>
  prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(
        hashtext(${organizationId}),
        hashtext('standalone_channel_team')
      )
    `)

    const existing = await transaction.team.findFirst({
      where: {
        project: { channelRoot: true, organizationId },
        systemManaged: true,
      },
      select: { id: true, projectId: true },
    })
    if (existing) {
      return { projectId: existing.projectId, teamId: existing.id }
    }

    const project = await transaction.project.create({
      data: {
        channelRoot: true,
        name: STANDALONE_CHANNEL_PROJECT_NAME,
        organizationId,
      },
      select: { id: true },
    })
    const team = await transaction.team.create({
      data: {
        name: STANDALONE_CHANNEL_TEAM_NAME,
        projectId: project.id,
        systemManaged: true,
      },
      select: { id: true },
    })
    return { projectId: project.id, teamId: team.id }
  })

/**
 * Create a channel on behalf of a user, who becomes its owner.
 *
 * Shared by `POST /api/channels` and the personal assistant's `channel_create`
 * tool: creating a channel by clicking and creating one by asking must be the
 * same operation, including the label validation, the scope-local slug
 * uniqueness, and the team/organization hierarchy check.
 */
export const createChannelForUser = async (
  prisma: PrismaClient,
  input: {
    /** See `ChannelModifier.isOrganizationAdmin`. */
    isOrganizationAdmin?: boolean
    label: string
    organizationId: string
    projectId?: string
    scope?: 'standalone'
    teamId?: string
    userId: string
    visibility: 'public' | 'protected' | 'private'
  },
): Promise<ChannelRecord | null> => {
  const label = validateChannelLabel(input.label)
  const teamProject = input.scope === 'standalone'
    ? await ensureStandaloneChannelTeam(prisma, input.organizationId)
    : input.teamId
      ? await loadChannelTeamProject(prisma, {
          organizationId: input.organizationId,
          projectId: input.projectId ?? '',
          teamId: input.teamId,
        })
      : null
  if (!teamProject) {
    return null
  }

  // A standalone channel names no team — it lands in the organisation's own
  // channel-root container, which every member reaches by definition. A team id
  // arrives in the request body, so it is the one that has to be earned.
  if (input.scope !== 'standalone') {
    const isOrganizationAdmin = await resolveOrganizationAdmin(prisma, input)
    // Adding a room to an existing project changes that project, so it takes
    // the project's own gate (`canModifyProject`: a member of it, or an
    // organisation owner or admin) — standing in the project's team is not
    // enough. The channel-root container is not a project anybody is in, so it
    // keeps the team rule alone.
    const project = await prisma.project.findUnique({
      where: { id: teamProject.projectId },
      select: { channelRoot: true },
    })
    if (project && !project.channelRoot && !(await canModifyProject(prisma, {
      isOrganizationAdmin,
      organizationId: input.organizationId,
      userId: input.userId,
    }, teamProject.projectId))) {
      throw new ChannelProjectAccessError(
        'You are not a member of that project, so a channel cannot be created in it.',
      )
    }
    if (!(await canPlaceChannelInTeam(prisma, {
      isOrganizationAdmin,
      organizationId: input.organizationId,
      projectId: teamProject.projectId,
      teamId: teamProject.teamId,
      userId: input.userId,
    }))) {
      throw new ChannelTeamAccessError(
        'You are not a member of that team, so a channel cannot be created in it.',
      )
    }
  }

  await ensureChannelSlugAvailable(prisma, {
    projectId: teamProject.projectId,
    scope: input.scope === 'standalone' ? 'standalone' : 'project',
    slug: label.slug,
  })

  try {
    const channel = await prisma.channel.create({
      data: {
        label: label.label,
        slug: label.slug,
        organizationId: input.organizationId,
        projectId: teamProject.projectId,
        teamId: teamProject.teamId,
        visibility: input.visibility,
        members: {
          create: {
            userId: input.userId,
            role: 'owner',
          },
        },
      },
      include: channelTeamInclude,
    })
    return mapChannelRecord(prisma, channel, input.userId, {
      isOrganizationAdmin: input.isOrganizationAdmin,
    })
  } catch (error) {
    throwIfChannelSlugConflict(
      error,
      label.slug,
      input.scope === 'standalone' ? 'standalone' : 'project',
    )
    throw error
  }
}
