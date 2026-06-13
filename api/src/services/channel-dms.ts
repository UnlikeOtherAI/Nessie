import { Prisma, type PrismaClient } from '@prisma/client'
import type { ChannelRecord } from '../contracts.js'
import { channelTeamInclude, mapChannelRecord } from './channels.js'
import {
  ensureChannelSlugAvailable,
  loadChannelTeamProject,
  throwIfChannelSlugConflict,
  validateChannelLabel,
} from './channel-slugs.js'

export const findOrCreateDmChannel = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    teamId: string
    currentUserId: string
    targetUserId: string
  },
): Promise<ChannelRecord | null> => {
  const teamProject = await loadChannelTeamProject(prisma, {
    organizationId: input.organizationId,
    teamId: input.teamId,
  })
  if (!teamProject) {
    return null
  }

  const memberCount = await prisma.organizationMember.count({
    where: {
      organizationId: input.organizationId,
      userId: { in: [input.currentUserId, input.targetUserId] },
    },
  })
  if (memberCount < 2) {
    return null
  }

  const dmKey = [
    input.organizationId,
    input.teamId,
    ...[input.currentUserId, input.targetUserId].sort(),
  ].join(':')

  const targetUser = await prisma.user.findUnique({
    where: { id: input.targetUserId },
    select: { displayName: true },
  })

  try {
    const channel = await prisma.channel.upsert({
      where: { dmKey },
      create: {
        label: targetUser?.displayName ?? 'Direct Message',
        type: 'dm',
        organizationId: input.organizationId,
        projectId: teamProject.projectId,
        teamId: input.teamId,
        visibility: 'private',
        dmKey,
        members: {
          create: [
            { userId: input.currentUserId },
            { userId: input.targetUserId },
          ],
        },
      },
      update: {},
      include: channelTeamInclude,
    })
    return mapChannelRecord(prisma, channel, input.currentUserId)
  } catch (err) {
    // Race condition: another request created the channel between our read and
    // write. The unique index on dmKey guarantees exactly one winner.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await prisma.channel.findUniqueOrThrow({
        where: { dmKey },
        include: channelTeamInclude,
      })
      return mapChannelRecord(prisma, existing, input.currentUserId)
    }
    throw err
  }
}

export const createGroupFromDm = async (
  prisma: PrismaClient,
  input: {
    dmChannelId: string
    newUserId: string
    currentUserId: string
  },
): Promise<ChannelRecord | null> => {
  const dmChannel = await prisma.channel.findUniqueOrThrow({
    where: { id: input.dmChannelId },
  })

  const isMember = await prisma.organizationMember.count({
    where: { organizationId: dmChannel.organizationId, userId: input.newUserId },
  })
  if (!isMember) {
    return null
  }

  const existingMembers = await prisma.channelMember.findMany({
    where: { channelId: input.dmChannelId },
    select: { userId: true },
  })
  const allUserIds = [
    ...new Set([
      ...existingMembers.map((m) => m.userId),
      input.newUserId,
    ]),
  ]

  const users = await prisma.user.findMany({
    where: { id: { in: allUserIds } },
    select: { id: true, displayName: true },
  })
  const otherNames = users
    .filter((u) => u.id !== input.currentUserId)
    .map((u) => u.displayName ?? 'Unknown')
    .sort()
  const label = validateChannelLabel(otherNames.join(', ') || 'Group')

  await ensureChannelSlugAvailable(prisma, {
    projectId: dmChannel.projectId,
    slug: label.slug,
  })

  try {
    const channel = await prisma.channel.create({
      data: {
        label: label.label,
        slug: label.slug,
        type: 'standard',
        organizationId: dmChannel.organizationId,
        projectId: dmChannel.projectId,
        teamId: dmChannel.teamId,
        visibility: 'private',
        members: {
          create: allUserIds.map((userId) => ({ userId })),
        },
      },
      include: channelTeamInclude,
    })

    return mapChannelRecord(prisma, channel, input.currentUserId)
  } catch (error) {
    throwIfChannelSlugConflict(error, label.slug)
    throw error
  }
}
