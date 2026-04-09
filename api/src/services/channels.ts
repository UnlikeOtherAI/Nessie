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
    return fallback!.id
  }
}

const mapChannelRecord = async (
  prisma: PrismaClient,
  channel: Channel,
): Promise<ChannelRecord> => ({
  id: parseChannelId(channel.id),
  label: channel.label,
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
  })

  return Promise.all(channels.map((channel) => mapChannelRecord(prisma, channel)))
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
