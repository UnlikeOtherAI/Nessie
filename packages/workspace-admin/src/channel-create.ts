import { Prisma, type PrismaClient } from '@prisma/client'
import type { ChannelRecord } from '@nessie/schemas'

import { channelTeamInclude, mapChannelRecord } from './channel-records.js'
import {
  ensureChannelSlugAvailable,
  loadChannelTeamProject,
  throwIfChannelSlugConflict,
  validateChannelLabel,
} from './channel-slugs.js'

const STANDALONE_CHANNEL_PROJECT_NAME = 'Standalone channels'
const STANDALONE_CHANNEL_TEAM_NAME = 'Standalone channels'

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
    label: string
    organizationId: string
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
          teamId: input.teamId,
        })
      : null
  if (!teamProject) {
    return null
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
    return mapChannelRecord(prisma, channel, input.userId)
  } catch (error) {
    throwIfChannelSlugConflict(
      error,
      label.slug,
      input.scope === 'standalone' ? 'standalone' : 'project',
    )
    throw error
  }
}
