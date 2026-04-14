import type { Channel, PrismaClient } from '@prisma/client'
import {
  parseChannelId,
  parseOrganizationId,
  parseTeamId,
  parseThreadId,
} from '@nessie/schemas'
import type { ChannelRecord } from '../contracts.js'

export const ensureDefaultThread = async (
  prisma: PrismaClient,
  channelId: string,
): Promise<string> => {
  // Use a single query to find the earliest thread, avoiding N+1 on channel listing
  const existingThread = await prisma.thread.findFirst({
    where: { channelId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })

  if (existingThread) {
    return existingThread.id
  }

  // Race-safe: if two requests try to create simultaneously, one will succeed
  try {
    const thread = await prisma.thread.create({
      data: { channelId, title: 'General' },
    })
    return thread.id
  } catch {
    // If creation failed (e.g., race), re-query
    const fallback = await prisma.thread.findFirst({
      where: { channelId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    if (!fallback) {
      throw new Error(`Failed to create or find default thread for channel ${channelId}`)
    }
    return fallback.id
  }
}

const mapChannelRecord = async (
  prisma: PrismaClient,
  channel: Channel,
): Promise<ChannelRecord> => ({
  id: parseChannelId(channel.id),
  label: channel.label,
  type: channel.type,
  visibility: channel.visibility,
  organizationId: parseOrganizationId(channel.organizationId),
  teamId: parseTeamId(channel.teamId),
  defaultThreadId: parseThreadId(await ensureDefaultThread(prisma, channel.id)),
  createdAt: channel.createdAt.toISOString(),
  updatedAt: channel.updatedAt.toISOString(),
})

export const listChannelsForUser = async (
  prisma: PrismaClient,
  userId: string,
  organizationId: string,
  teamId?: string,
): Promise<ChannelRecord[]> => {
  const where: Record<string, unknown> = {
    organizationId,
    OR: [
      { visibility: 'public' },
      { members: { some: { userId } } },
    ],
  }
  if (teamId) {
    where['teamId'] = teamId
  }

  const channels = await prisma.channel.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    include: {
      threads: {
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { id: true },
      },
    },
  })

  // Create default threads only for channels that don't have one (batch)
  const needsThread = channels.filter((c) => c.threads.length === 0)
  if (needsThread.length > 0) {
    await prisma.thread.createMany({
      data: needsThread.map((c) => ({ channelId: c.id, title: 'General' })),
      skipDuplicates: true,
    })
    // Re-fetch threads for those channels
    const createdThreads = await prisma.thread.findMany({
      where: { channelId: { in: needsThread.map((c) => c.id) } },
      orderBy: { createdAt: 'asc' },
      distinct: ['channelId'],
      select: { id: true, channelId: true },
    })
    const threadMap = new Map(createdThreads.map((t) => [t.channelId, t.id]))
    for (const channel of needsThread) {
      const threadId = threadMap.get(channel.id)
      if (threadId) {
        channel.threads = [{ id: threadId }]
      } else {
        // Defensive fallback for partial batch failures
        const fallback = await ensureDefaultThread(prisma, channel.id)
        channel.threads = [{ id: fallback }]
      }
    }
  }

  return channels.map((channel) => ({
    id: parseChannelId(channel.id),
    label: channel.label,
    type: channel.type,
    visibility: channel.visibility,
    organizationId: parseOrganizationId(channel.organizationId),
    teamId: parseTeamId(channel.teamId),
    defaultThreadId: parseThreadId(channel.threads[0]!.id),
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
  }))
}

export const addMemberToChannel = async (
  prisma: PrismaClient,
  channelId: string,
  userId: string,
): Promise<void> => {
  await prisma.channelMember.upsert({
    where: { channelId_userId: { channelId, userId } },
    create: { channelId, userId },
    update: {},
  })
}

export const removeMemberFromChannel = async (
  prisma: PrismaClient,
  channelId: string,
  userId: string,
): Promise<void> => {
  await prisma.channelMember.deleteMany({
    where: { channelId, userId },
  })
}

export const validateTenantHierarchy = async (
  prisma: PrismaClient,
  organizationId: string,
  teamId: string,
): Promise<boolean> => {
  // Verify team belongs to a project that belongs to the organization
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: { project: { select: { organizationId: true } } },
  })
  return team?.project?.organizationId === organizationId
}

export const findOrCreateDmChannel = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    teamId: string
    currentUserId: string
    targetUserId: string
  },
): Promise<ChannelRecord | null> => {
  // Validate both users belong to the organization
  const memberCount = await prisma.organizationMember.count({
    where: {
      organizationId: input.organizationId,
      userId: { in: [input.currentUserId, input.targetUserId] },
    },
  })
  if (memberCount < 2) {
    return null
  }

  // Deterministic key for race-safe DM dedup (scoped to org+team)
  const dmKey = [input.organizationId, input.teamId, ...[input.currentUserId, input.targetUserId].sort()].join(':')

  // Look up the target user's display name for the channel label
  const targetUser = await prisma.user.findUnique({
    where: { id: input.targetUserId },
    select: { displayName: true },
  })

  // Upsert on dmKey — idempotent, race-safe
  const channel = await prisma.channel.upsert({
    where: { dmKey },
    create: {
      label: targetUser?.displayName ?? 'Direct Message',
      type: 'dm',
      organizationId: input.organizationId,
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
  })

  return mapChannelRecord(prisma, channel)
}

export const createGroupFromDm = async (
  prisma: PrismaClient,
  input: {
    dmChannelId: string
    newUserId: string
    currentUserId: string
  },
): Promise<ChannelRecord | null> => {
  // Get the DM channel for org/team context first (needed for org membership check)
  const dmChannel = await prisma.channel.findUniqueOrThrow({
    where: { id: input.dmChannelId },
  })

  // Validate newUserId belongs to the same organization
  const isMember = await prisma.organizationMember.count({
    where: { organizationId: dmChannel.organizationId, userId: input.newUserId },
  })
  if (!isMember) {
    return null
  }

  // Get all current members of the DM
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

  // Build the label from display names of all members except current user
  const users = await prisma.user.findMany({
    where: { id: { in: allUserIds } },
    select: { id: true, displayName: true },
  })
  const otherNames = users
    .filter((u) => u.id !== input.currentUserId)
    .map((u) => u.displayName ?? 'Unknown')
    .sort()
  const label = otherNames.join(', ')

  const channel = await prisma.channel.create({
    data: {
      label: label || 'Group',
      type: 'standard',
      organizationId: dmChannel.organizationId,
      teamId: dmChannel.teamId,
      visibility: 'private',
      members: {
        create: allUserIds.map((userId) => ({ userId })),
      },
    },
  })

  return mapChannelRecord(prisma, channel)
}

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
  // Enforce tenant hierarchy: team's project must belong to the same org
  if (!(await validateTenantHierarchy(prisma, input.organizationId, input.teamId))) {
    return null
  }

  const channel = await prisma.channel.create({
    data: {
      label: input.label,
      organizationId: input.organizationId,
      teamId: input.teamId,
      visibility: input.visibility,
      members: {
        create: {
          userId: input.userId,
        },
      },
    },
  })

  return mapChannelRecord(prisma, channel)
}
