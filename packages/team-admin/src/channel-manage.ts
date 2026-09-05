import { Prisma } from '@prisma/client'
import type { Channel, PrismaClient } from '@prisma/client'
import type { ChannelRecord } from '@nessie/schemas'

import { channelTeamInclude, mapChannelRecord } from './channel-records.js'
import type { ChannelSlugScope } from './channel-slugs.js'
import {
  ensureChannelSlugAvailable,
  resolveChannelSlugScope,
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

  // System channels are lifecycle-protected: their label, archive state and
  // membership are bootstrap-owned facts other rules depend on (a global
  // agent's home DM must stay reachable and single-member). Nobody manages one
  // by clicking or by asking; the ensure functions repair them instead.
  if (channel.systemChannelType) {
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
  // A standalone channel renamed into a taken name was told the conflict was
  // "in this project" — a project the person has never seen and cannot open.
  // The scope comes from the row so the sentence names the shared-channel list.
  let scope: ChannelSlugScope = 'project'
  if (input.label !== undefined) {
    const label = validateChannelLabel(input.label)
    scope = await resolveChannelSlugScope(prisma, manage.channel.projectId)
    await ensureChannelSlugAvailable(prisma, {
      excludeChannelId: input.channelId,
      projectId: manage.channel.projectId,
      scope,
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
      throwIfChannelSlugConflict(error, validateChannelLabel(input.label).slug, scope)
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

  // Archiving releases the name (`ensureChannelSlugAvailable` and the partial
  // unique index both ignore archived rows), so coming back is the moment the
  // name has to be free again. Checking here turns a raw constraint violation
  // into a sentence that says which channel to rename.
  const reclaimedSlug =
    !input.archived
    && manage.channel.archivedAt !== null
    && manage.channel.type === 'standard'
      ? manage.channel.slug
      : null
  const scope = reclaimedSlug === null
    ? 'project'
    : await resolveChannelSlugScope(prisma, manage.channel.projectId)
  if (reclaimedSlug !== null) {
    await ensureChannelSlugAvailable(prisma, {
      excludeChannelId: input.channelId,
      intent: 'restore',
      projectId: manage.channel.projectId,
      scope,
      slug: reclaimedSlug,
    })
  }

  try {
    const channel = await prisma.channel.update({
      where: { id: input.channelId },
      data: { archivedAt: input.archived ? new Date() : null },
      include: channelTeamInclude,
    })
    return mapChannelRecord(prisma, channel, input.userId)
  } catch (error) {
    if (reclaimedSlug !== null) {
      throwIfChannelSlugConflict(error, reclaimedSlug, scope, 'restore')
    }
    throw error
  }
}
