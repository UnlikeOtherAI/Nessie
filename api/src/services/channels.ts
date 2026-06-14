import { Prisma } from '@prisma/client'
import type { Channel, PrismaClient } from '@prisma/client'
import {
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  parseThreadId,
} from '@nessie/schemas'
import type { ChannelRecord } from '../contracts.js'
import {
  channelTeamInclude,
  ensureDefaultThread,
  loadUnreadCountsByThread,
  mapChannelRecord,
  resolveDmUserId,
} from './channel-records.js'
import {
  ChannelSlugConflictError,
  ChannelValidationError,
  ensureChannelSlugAvailable,
  loadChannelTeamProject,
  throwIfChannelSlugConflict,
  validateChannelLabel,
} from './channel-slugs.js'

export { ChannelSlugConflictError, ChannelValidationError }

export const listChannelsForUser = async (
  prisma: PrismaClient,
  userId: string,
  organizationId: string,
  teamId?: string,
  includeArchived = false,
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
  if (!includeArchived) {
    where['archivedAt'] = null
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
      members: {
        where: { userId },
        select: { role: true, muted: true },
        take: 1,
      },
      team: {
        select: {
          name: true,
          project: {
            select: { id: true, name: true },
          },
        },
      },
    },
  })

  const needsThread = channels.filter((channel) => channel.threads.length === 0)
  if (needsThread.length > 0) {
    await prisma.thread.createMany({
      data: needsThread.map((channel) => ({ channelId: channel.id, title: 'General' })),
      skipDuplicates: true,
    })

    const createdThreads = await prisma.thread.findMany({
      where: { channelId: { in: needsThread.map((channel) => channel.id) } },
      orderBy: { createdAt: 'asc' },
      distinct: ['channelId'],
      select: { id: true, channelId: true },
    })
    const threadMap = new Map(createdThreads.map((thread) => [thread.channelId, thread.id]))
    for (const channel of needsThread) {
      const threadId = threadMap.get(channel.id)
      channel.threads = [{ id: threadId ?? await ensureDefaultThread(prisma, channel.id) }]
    }
  }

  channels.sort((left, right) => {
    const leftPriority = left.systemChannelType === 'personal_assistant' ? 0 : 1
    const rightPriority = right.systemChannelType === 'personal_assistant' ? 0 : 1
    return leftPriority - rightPriority || left.createdAt.getTime() - right.createdAt.getTime()
  })

  const unreadCountsByThread = await loadUnreadCountsByThread(
    prisma,
    channels.map((channel) => channel.threads[0]!.id),
    userId,
  )

  return channels.map((channel) => ({
    id: parseChannelId(channel.id),
    label: channel.label,
    slug: channel.slug,
    type: channel.type,
    systemChannelType: channel.systemChannelType ?? undefined,
    dmUserId: resolveDmUserId(channel, userId),
    visibility: channel.visibility,
    organizationId: parseOrganizationId(channel.organizationId),
    projectId: parseProjectId(channel.team.project.id),
    projectName: channel.team.project.name,
    teamId: parseTeamId(channel.teamId),
    teamName: channel.team.name,
    defaultThreadId: parseThreadId(channel.threads[0]!.id),
    unreadCount: unreadCountsByThread.get(channel.threads[0]!.id) ?? 0,
    topic: channel.topic ?? null,
    description: channel.description ?? null,
    archivedAt: channel.archivedAt?.toISOString() ?? null,
    memberRole: channel.members[0]?.role ?? null,
    muted: channel.members[0]?.muted ?? false,
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
  }))
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

export const joinPublicChannel = async (
  prisma: PrismaClient,
  input: { userId: string; organizationId: string; channelId: string },
): Promise<ChannelRecord | null> => {
  const channel = await prisma.channel.findUnique({
    where: { id: input.channelId },
    select: { organizationId: true, visibility: true, archivedAt: true },
  })
  if (!channel || channel.organizationId !== input.organizationId) {
    return null
  }
  if (channel.visibility !== 'public' || channel.archivedAt) {
    return null
  }

  const isOrgMember = await prisma.organizationMember.count({
    where: { organizationId: input.organizationId, userId: input.userId },
  })
  if (!isOrgMember) {
    return null
  }

  await prisma.channelMember.upsert({
    where: { channelId_userId: { channelId: input.channelId, userId: input.userId } },
    create: { channelId: input.channelId, userId: input.userId },
    update: {},
  })

  const joined = await prisma.channel.findUniqueOrThrow({
    where: { id: input.channelId },
    include: channelTeamInclude,
  })
  return mapChannelRecord(prisma, joined, input.userId)
}
