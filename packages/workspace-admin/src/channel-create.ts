import type { PrismaClient } from '@prisma/client'
import type { ChannelRecord } from '@nessie/schemas'

import { channelTeamInclude, mapChannelRecord } from './channel-records.js'
import {
  ensureChannelSlugAvailable,
  loadChannelTeamProject,
  throwIfChannelSlugConflict,
  validateChannelLabel,
} from './channel-slugs.js'

/**
 * Create a channel on behalf of a user, who becomes its owner.
 *
 * Shared by `POST /api/channels` and the personal assistant's `channel_create`
 * tool: creating a channel by clicking and creating one by asking must be the
 * same operation, including the label validation, the per-project slug
 * uniqueness, and the team/organization hierarchy check.
 */
export const createChannelForUser = async (
  prisma: PrismaClient,
  input: {
    label: string
    organizationId: string
    teamId: string
    userId: string
    visibility: 'public' | 'protected' | 'private'
  },
): Promise<ChannelRecord | null> => {
  const label = validateChannelLabel(input.label)
  const teamProject = await loadChannelTeamProject(prisma, {
    organizationId: input.organizationId,
    teamId: input.teamId,
  })
  if (!teamProject) {
    return null
  }

  await ensureChannelSlugAvailable(prisma, {
    projectId: teamProject.projectId,
    slug: label.slug,
  })

  try {
    const channel = await prisma.channel.create({
      data: {
        label: label.label,
        slug: label.slug,
        organizationId: input.organizationId,
        projectId: teamProject.projectId,
        teamId: input.teamId,
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
    throwIfChannelSlugConflict(error, label.slug)
    throw error
  }
}
