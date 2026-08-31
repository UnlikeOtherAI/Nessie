import { Prisma, type PrismaClient } from '@prisma/client'
import type { ChannelRecord } from '../contracts.js'
import {
  channelTeamInclude,
  loadChannelTeamProject,
  mapChannelRecord,
  validateChannelLabel,
} from '@nessie/workspace-admin'

const uniqueParticipantIds = (currentUserId: string, targetUserId: string): string[] =>
  Array.from(new Set([currentUserId, targetUserId]))

const uniqueIds = (ids: string[]): string[] => Array.from(new Set(ids))

const isUniqueConstraintError = (error: unknown): error is Prisma.PrismaClientKnownRequestError =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

const agentDmKey = (input: {
  agentId: string
  currentUserId: string
  organizationId: string
  teamId: string
}): string =>
  [
    input.organizationId,
    input.teamId,
    input.currentUserId,
    'agent',
    input.agentId,
  ].join(':')

const groupDmKey = (input: {
  agentIds: string[]
  organizationId: string
  teamId: string
  userIds: string[]
}): string => [
  input.organizationId,
  input.teamId,
  'group',
  ...uniqueIds(input.userIds).sort(),
  'agents',
  ...uniqueIds(input.agentIds).sort(),
].join(':')

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
            projectId: teamProject.projectId,
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
        projectId: teamProject.projectId,
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
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const existing = await prisma.channel.findUniqueOrThrow({
        where: { dmKey },
        include: channelTeamInclude,
      })
      return mapChannelRecord(prisma, existing, input.currentUserId)
    }
    throw error
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
    include: {
      agentBindings: {
        select: { agentId: true },
      },
    },
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
      ...existingMembers.map((member) => member.userId),
      input.newUserId,
    ]),
  ]

  const users = await prisma.user.findMany({
    where: { id: { in: allUserIds } },
    select: { id: true, displayName: true },
  })
  const otherNames = users
    .filter((user) => user.id !== input.currentUserId)
    .map((user) => user.displayName ?? 'Unknown')
    .sort()
  const label = validateChannelLabel(otherNames.join(', ') || 'Group')
  const agentIds = dmChannel.agentBindings.map((binding) => binding.agentId)
  const dmKey = groupDmKey({
    agentIds,
    organizationId: dmChannel.organizationId,
    teamId: dmChannel.teamId,
    userIds: allUserIds,
  })

  try {
    const channel = await prisma.channel.upsert({
      where: { dmKey },
      create: {
        label: label.label,
        type: 'dm',
        organizationId: dmChannel.organizationId,
        projectId: dmChannel.projectId,
        teamId: dmChannel.teamId,
        visibility: 'private',
        dmKey,
        members: {
          create: allUserIds.map((userId) => ({
            userId,
            role: userId === input.currentUserId ? 'owner' : 'member',
          })),
        },
        ...(agentIds.length > 0
          ? {
              agentBindings: {
                create: agentIds.map((agentId) => ({ agentId })),
              },
            }
          : {}),
      },
      update: {},
      include: channelTeamInclude,
    })
    return mapChannelRecord(prisma, channel, input.currentUserId)
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const existing = await prisma.channel.findUniqueOrThrow({
        where: { dmKey },
        include: channelTeamInclude,
      })
      return mapChannelRecord(prisma, existing, input.currentUserId)
    }
    throw error
  }
}

export const findOrCreateAgentDmChannel = async (
  prisma: PrismaClient,
  input: {
    agentId: string
    currentUserId: string
    organizationId: string
    teamId: string
  },
): Promise<ChannelRecord | null> => {
  const teamProject = await loadChannelTeamProject(prisma, {
    organizationId: input.organizationId,
    teamId: input.teamId,
  })
  if (!teamProject) {
    return null
  }

  const [isOrgMember, agent] = await Promise.all([
    prisma.organizationMember.count({
      where: {
        organizationId: input.organizationId,
        userId: input.currentUserId,
      },
    }),
    prisma.agent.findFirst({
      where: {
        agentKind: 'shared',
        id: input.agentId,
        organizationId: input.organizationId,
        surfacePolicy: 'shared',
        systemManaged: false,
      },
      select: { id: true, name: true },
    }),
  ])
  if (!isOrgMember || !agent) {
    return null
  }

  const dmKey = agentDmKey(input)

  try {
    const channel = await prisma.channel.upsert({
      where: { dmKey },
      create: {
        label: agent.name,
        type: 'dm',
        organizationId: input.organizationId,
        projectId: teamProject.projectId,
        teamId: input.teamId,
        visibility: 'private',
        dmKey,
        members: {
          create: { userId: input.currentUserId, role: 'owner' },
        },
        agentBindings: {
          create: { agentId: agent.id },
        },
      },
      update: {},
      include: channelTeamInclude,
    })
    await prisma.agentBinding.createMany({
      data: [{ agentId: agent.id, channelId: channel.id }],
      skipDuplicates: true,
    })
    return mapChannelRecord(prisma, channel, input.currentUserId)
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const existing = await prisma.channel.findUniqueOrThrow({
        where: { dmKey },
        include: channelTeamInclude,
      })
      return mapChannelRecord(prisma, existing, input.currentUserId)
    }
    throw error
  }
}

export const findOrCreatePrivateConversationChannel = async (
  prisma: PrismaClient,
  input: {
    agentIds: string[]
    currentUserId: string
    organizationId: string
    teamId: string
    userIds: string[]
  },
): Promise<ChannelRecord | null> => {
  const selectedUserIds = uniqueIds(input.userIds)
  const selectedOtherUserIds = selectedUserIds.filter(
    (userId) => userId !== input.currentUserId,
  )
  const selectedAgentIds = uniqueIds(input.agentIds)

  if (selectedOtherUserIds.length === 0 && selectedAgentIds.length === 0) {
    return findOrCreateDmChannel(prisma, {
      currentUserId: input.currentUserId,
      organizationId: input.organizationId,
      targetUserId: input.currentUserId,
      teamId: input.teamId,
    })
  }

  if (selectedOtherUserIds.length === 1 && selectedAgentIds.length === 0) {
    return findOrCreateDmChannel(prisma, {
      currentUserId: input.currentUserId,
      organizationId: input.organizationId,
      targetUserId: selectedOtherUserIds[0]!,
      teamId: input.teamId,
    })
  }

  if (selectedOtherUserIds.length === 0 && selectedAgentIds.length === 1) {
    return findOrCreateAgentDmChannel(prisma, {
      agentId: selectedAgentIds[0]!,
      currentUserId: input.currentUserId,
      organizationId: input.organizationId,
      teamId: input.teamId,
    })
  }

  const teamProject = await loadChannelTeamProject(prisma, {
    organizationId: input.organizationId,
    teamId: input.teamId,
  })
  if (!teamProject) {
    return null
  }

  const memberUserIds = uniqueIds([input.currentUserId, ...selectedUserIds])
  const [users, agents] = await Promise.all([
    prisma.user.findMany({
      where: {
        id: { in: memberUserIds },
        organizationMembers: {
          some: { organizationId: input.organizationId },
        },
      },
      select: { id: true, displayName: true },
    }),
    prisma.agent.findMany({
      where: {
        agentKind: 'shared',
        id: { in: selectedAgentIds },
        organizationId: input.organizationId,
        surfacePolicy: 'shared',
        systemManaged: false,
      },
      select: { id: true, name: true },
    }),
  ])
  if (users.length !== memberUserIds.length || agents.length !== selectedAgentIds.length) {
    return null
  }

  const userNameById = new Map(users.map((user) => [user.id, user.displayName]))
  const agentNameById = new Map(agents.map((agent) => [agent.id, agent.name]))
  const participantNames = [
    ...selectedOtherUserIds.map((userId) => userNameById.get(userId) ?? 'Unknown'),
    ...selectedAgentIds.map((agentId) => agentNameById.get(agentId) ?? 'Agent'),
  ]
  const label = participantNames.join(', ') || 'Private chat'
  const dmKey = groupDmKey({
    agentIds: selectedAgentIds,
    organizationId: input.organizationId,
    teamId: input.teamId,
    userIds: memberUserIds,
  })

  try {
    const channel = await prisma.channel.upsert({
      where: { dmKey },
      create: {
        label,
        type: 'dm',
        organizationId: input.organizationId,
        projectId: teamProject.projectId,
        teamId: input.teamId,
        visibility: 'private',
        dmKey,
        members: {
          create: memberUserIds.map((userId) => ({
            userId,
            role: userId === input.currentUserId ? 'owner' : 'member',
          })),
        },
        ...(selectedAgentIds.length > 0
          ? {
              agentBindings: {
                create: selectedAgentIds.map((agentId) => ({ agentId })),
              },
            }
          : {}),
      },
      update: {},
      include: channelTeamInclude,
    })
    return mapChannelRecord(prisma, channel, input.currentUserId)
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const existing = await prisma.channel.findUniqueOrThrow({
        where: { dmKey },
        include: channelTeamInclude,
      })
      return mapChannelRecord(prisma, existing, input.currentUserId)
    }
    throw error
  }
}
