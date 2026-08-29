import { Prisma } from '@prisma/client'
import type { Channel, PrismaClient } from '@prisma/client'
import type { ChannelRecord } from '@nessie/schemas'

import { channelTeamInclude, mapChannelRecord } from './channel-records.js'
import {
  ensureChannelSlugAvailable,
  throwIfChannelSlugConflict,
  validateChannelLabel,
} from './channel-slugs.js'

/**
 * Who may manage a channel, and the writes that authorization gates.
 *
 * Shared by the channel/thread routes and the personal assistant's
 * `channel_update` / `channel_archive` tools: renaming or archiving a channel by
 * clicking and by asking are the same operation, down to the label chokepoint
 * and the slug-conflict translation. Only how the outcome is spoken differs, and
 * that stays at the call sites.
 */

/**
 * Channel owner/admin, organization owner/admin, or team owner/admin. The
 * channel row comes back with it so a caller that needs the scope — the rename's
 * slug pre-check needs `projectId` — does not read it twice.
 */
export const canManageChannel = async (
  prisma: PrismaClient,
  input: { userId: string; organizationId: string; channelId: string },
): Promise<{ channel: Channel } | null> => {
  const channel = await prisma.channel.findUnique({
    where: { id: input.channelId },
  })
  if (!channel || channel.organizationId !== input.organizationId) {
    return null
  }

  const [channelMember, orgMember, teamMember] = await Promise.all([
    prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId: input.channelId, userId: input.userId } },
      select: { role: true },
    }),
    prisma.organizationMember.findFirst({
      where: { organizationId: input.organizationId, userId: input.userId },
      select: { role: true },
    }),
    prisma.teamMember.findFirst({
      where: { teamId: channel.teamId, userId: input.userId },
      select: { role: true },
    }),
  ])

  const isManager =
    channelMember?.role === 'owner'
    || channelMember?.role === 'admin'
    || orgMember?.role === 'owner'
    || orgMember?.role === 'admin'
    || teamMember?.role === 'owner'
    || teamMember?.role === 'admin'

  return isManager ? { channel } : null
}

export const updateChannel = async (
  prisma: PrismaClient,
  input: {
    userId: string
    organizationId: string
    channelId: string
    label?: string
    topic?: string | null
    description?: string | null
  },
): Promise<ChannelRecord | null> => {
  const manage = await canManageChannel(prisma, input)
  if (!manage) {
    return null
  }

  const data: Prisma.ChannelUpdateInput = {}
  if (input.label !== undefined) {
    const label = validateChannelLabel(input.label)
    await ensureChannelSlugAvailable(prisma, {
      excludeChannelId: input.channelId,
      projectId: manage.channel.projectId,
      slug: label.slug,
    })
    data.label = label.label
    data.slug = label.slug
  }
  if (input.topic !== undefined) {
    data.topic = input.topic
  }
  if (input.description !== undefined) {
    data.description = input.description
  }

  try {
    const channel = await prisma.channel.update({
      where: { id: input.channelId },
      data,
      include: channelTeamInclude,
    })
    return mapChannelRecord(prisma, channel, input.userId)
  } catch (error) {
    if (input.label !== undefined) {
      throwIfChannelSlugConflict(error, validateChannelLabel(input.label).slug)
    }
    throw error
  }
}

export const setChannelArchived = async (
  prisma: PrismaClient,
  input: {
    userId: string
    organizationId: string
    channelId: string
    archived: boolean
  },
): Promise<ChannelRecord | null> => {
  const manage = await canManageChannel(prisma, input)
  if (!manage) {
    return null
  }

  const channel = await prisma.channel.update({
    where: { id: input.channelId },
    data: { archivedAt: input.archived ? new Date() : null },
    include: channelTeamInclude,
  })
  return mapChannelRecord(prisma, channel, input.userId)
}
