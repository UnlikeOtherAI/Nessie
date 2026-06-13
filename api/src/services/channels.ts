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
  loadTeamProjectScope,
  mapChannelRecord,
} from './channel-records.js'

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
  // sp-channels: exclude soft-archived channels from default listings
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
      // sp-channels: include the caller's membership row to surface memberRole
      members: {
        where: { userId },
        select: { role: true },
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
    type: channel.type,
    systemChannelType: channel.systemChannelType ?? undefined,
    visibility: channel.visibility,
    organizationId: parseOrganizationId(channel.organizationId),
    projectId: parseProjectId(channel.team.project.id),
    projectName: channel.team.project.name,
    teamId: parseTeamId(channel.teamId),
    teamName: channel.team.name,
    defaultThreadId: parseThreadId(channel.threads[0]!.id),
    unreadCount: unreadCountsByThread.get(channel.threads[0]!.id) ?? 0,
    // sp-channels: lifecycle fields
    topic: channel.topic ?? null,
    description: channel.description ?? null,
    archivedAt: channel.archivedAt?.toISOString() ?? null,
    memberRole: channel.members[0]?.role ?? null,
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
  }))
}

export const addMemberToChannel = async (
  prisma: PrismaClient,
  channelId: string,
  userId: string,
): Promise<boolean> => {
  // Load the channel's org and confirm the target user belongs to it before
  // the upsert, so a cross-org user can never be added to a channel.
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { organizationId: true },
  })
  if (!channel) {
    return false
  }

  const isOrgMember = await prisma.organizationMember.count({
    where: { organizationId: channel.organizationId, userId },
  })
  if (!isOrgMember) {
    return false
  }

  await prisma.channelMember.upsert({
    where: { channelId_userId: { channelId, userId } },
    create: { channelId, userId },
    update: {},
  })
  return true
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
  const scope = await loadTeamProjectScope(prisma, { organizationId, teamId })
  return scope !== null
}

// sp-channels: mirror of the admin `toSlug` rules. Channel labels are validated
// server-side so the API never persists a name the admin UI would reject.
export const toChannelSlug = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

export class ChannelValidationError extends Error {}

const validateChannelLabel = (label: string): string => {
  const trimmed = label.trim()
  if (toChannelSlug(trimmed).length === 0) {
    throw new ChannelValidationError(
      'Channel name must contain at least one letter or number',
    )
  }
  return trimmed
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
  // sp-channels: enforce the same name/slug rules the admin applies client-side.
  const label = validateChannelLabel(input.label)
  const slug = toChannelSlug(label)

  // Enforce tenant hierarchy: team's project must belong to the same org.
  const scope = await loadTeamProjectScope(prisma, input)
  if (!scope) {
    return null
  }

  const channel = await prisma.channel.create({
    data: {
      label,
      organizationId: input.organizationId,
      projectId: scope.projectId,
      slug,
      teamId: input.teamId,
      visibility: input.visibility,
      members: {
        // sp-channels: the creator becomes the channel owner so they can manage it
        create: {
          userId: input.userId,
          role: 'owner',
        },
      },
    },
    include: channelTeamInclude,
  })

  return mapChannelRecord(prisma, channel, input.userId)
}

// ─── sp-channels: channel lifecycle ──────────────────────────────────────────

// A principal may manage a channel if they are a channel member with role
// owner/admin, OR an org owner/admin, OR a team owner/admin. This is the single
// authz seam shared by the REST routes and the agent built-in tools.
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
    data.label = label
    data.slug = toChannelSlug(label)
  }
  if (input.topic !== undefined) {
    data.topic = input.topic
  }
  if (input.description !== undefined) {
    data.description = input.description
  }

  const channel = await prisma.channel.update({
    where: { id: input.channelId },
    data,
    include: channelTeamInclude,
  })
  return mapChannelRecord(prisma, channel, input.userId)
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

// Public channels are open to any org member; private/protected still require
// an explicit invite (addMemberToChannel by an existing member).
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
