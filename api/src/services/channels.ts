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
  const existingThread = await prisma.thread.findFirst({
    where: { channelId },
    orderBy: { createdAt: 'asc' },
  })

  if (existingThread) {
    return existingThread.id
  }

  const thread = await prisma.thread.create({
    data: {
      channelId,
      title: 'General',
    },
  })

  return thread.id
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
): Promise<ChannelRecord[]> => {
  const channels = await prisma.channel.findMany({
    where: {
      organizationId,
      members: {
        some: { userId },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  return Promise.all(channels.map((channel) => mapChannelRecord(prisma, channel)))
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
): Promise<ChannelRecord> => {
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
