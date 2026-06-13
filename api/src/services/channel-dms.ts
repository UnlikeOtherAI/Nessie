import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type { ChannelRecord } from '../contracts.js'
import {
  channelTeamInclude,
  loadTeamProjectScope,
  mapChannelRecord,
} from './channel-records.js'
import { toChannelSlug } from './channels.js'

const uniqueParticipantIds = (currentUserId: string, targetUserId: string): string[] =>
  Array.from(new Set([currentUserId, targetUserId]))

const isUniqueConstraintError = (error: unknown): error is Prisma.PrismaClientKnownRequestError =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

export const findOrCreateDmChannel = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    teamId: string
    currentUserId: string
    targetUserId: string
  },
): Promise<ChannelRecord | null> => {
  const participantUserIds = uniqueParticipantIds(input.currentUserId, input.targetUserId)

  const memberCount = await prisma.organizationMember.count({
    where: {
      organizationId: input.organizationId,
      userId: { in: participantUserIds },
    },
  })
  if (memberCount !== participantUserIds.length) {
    return null
  }

  const scope = await loadTeamProjectScope(prisma, input)
  if (!scope) {
    return null
  }

  const dmKey = [
    input.organizationId,
    input.teamId,
    ...[input.currentUserId, input.targetUserId].sort(),
  ].join(':')
  const legacySelfDmKey = input.currentUserId === input.targetUserId
    ? [input.organizationId, input.teamId, input.currentUserId].join(':')
    : null

  const targetUser = await prisma.user.findUnique({
    where: { id: input.targetUserId },
    select: { displayName: true },
  })
  const label = targetUser?.displayName ?? 'Direct Message'

  if (legacySelfDmKey && legacySelfDmKey !== dmKey) {
    const legacyChannel = await prisma.channel.findUnique({
      where: { dmKey: legacySelfDmKey },
      include: channelTeamInclude,
    })
    if (legacyChannel) {
      try {
        const migratedChannel = await prisma.channel.update({
          where: { id: legacyChannel.id },
          data: {
            dmKey,
            label,
            projectId: scope.projectId,
          },
          include: channelTeamInclude,
        })
        return mapChannelRecord(prisma, migratedChannel, input.currentUserId)
      } catch (error) {
        if (!isUniqueConstraintError(error)) {
          throw error
        }
      }
    }
  }

  try {
    const channel = await prisma.channel.upsert({
      where: { dmKey },
      create: {
        label,
        type: 'dm',
        organizationId: input.organizationId,
        projectId: scope.projectId,
        teamId: input.teamId,
        visibility: 'private',
        dmKey,
        members: {
          create: participantUserIds.map((userId) => ({ userId })),
        },
      },
      update: {},
      include: channelTeamInclude,
    })
    return mapChannelRecord(prisma, channel, input.currentUserId)
  } catch (err) {
    if (isUniqueConstraintError(err)) {
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
  const label = otherNames.join(', ')
  const slug = toChannelSlug(label || 'Group')

  const channel = await prisma.channel.create({
    data: {
      label: label || 'Group',
      type: 'standard',
      organizationId: dmChannel.organizationId,
      projectId: dmChannel.projectId,
      slug,
      teamId: dmChannel.teamId,
      visibility: 'private',
      members: {
        create: allUserIds.map((userId) => ({ userId })),
      },
    },
    include: channelTeamInclude,
  })

  return mapChannelRecord(prisma, channel, input.currentUserId)
}
