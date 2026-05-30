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

type ChannelWithProject = Channel & {
  team?: {
    name: string
    project: {
      id: string
      name: string
    }
  }
}

type ThreadUnreadRow = {
  thread_id: string
  unread_count: bigint | number
}

// Shared include so create/upsert sites return the channel's team + project in
// one query — mapChannelRecord then never needs a follow-up team lookup.
const channelTeamInclude = {
  team: {
    select: {
      name: true,
      project: {
        select: { id: true, name: true },
      },
    },
  },
} satisfies Prisma.ChannelInclude

const loadUnreadCountsByThread = async (
  prisma: PrismaClient,
  threadIds: string[],
  userId: string,
): Promise<Map<string, number>> => {
  if (threadIds.length === 0) {
    return new Map()
  }

  const rows = await prisma.$queryRaw<ThreadUnreadRow[]>(Prisma.sql`
    SELECT
      t.id AS thread_id,
      COALESCE(
        SUM(
          CASE
            WHEN m.id IS NOT NULL
              AND (m.user_id IS NULL OR m.user_id <> ${userId}::uuid)
              AND (trs.last_read_at IS NULL OR m.created_at > trs.last_read_at)
            THEN 1
            ELSE 0
          END
        ),
        0
      ) AS unread_count
    FROM "threads" t
    LEFT JOIN "thread_read_states" trs
      ON trs.thread_id = t.id
      AND trs.user_id = ${userId}::uuid
    LEFT JOIN "messages" m
      ON m.thread_id = t.id
    WHERE t.id IN (${Prisma.join(threadIds.map((threadId) => Prisma.sql`${threadId}::uuid`))})
    GROUP BY t.id
  `)

  return new Map(
    rows.map((row) => [
      row.thread_id,
      typeof row.unread_count === 'bigint'
        ? Number(row.unread_count)
        : row.unread_count,
    ]),
  )
}

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
  channel: ChannelWithProject,
  userId?: string,
): Promise<ChannelRecord> => {
  const defaultThreadId = await ensureDefaultThread(prisma, channel.id)
  const unreadCount = userId
    ? (await loadUnreadCountsByThread(prisma, [defaultThreadId], userId)).get(defaultThreadId) ?? 0
    : 0
  const team = channel.team ?? await prisma.team.findUniqueOrThrow({
    where: { id: channel.teamId },
    select: {
      name: true,
      project: {
        select: { id: true, name: true },
      },
    },
  })

  return {
    defaultThreadId: parseThreadId(defaultThreadId),
    id: parseChannelId(channel.id),
    label: channel.label,
    type: channel.type,
    systemChannelType: channel.systemChannelType ?? undefined,
    visibility: channel.visibility,
    organizationId: parseOrganizationId(channel.organizationId),
    projectId: parseProjectId(team.project.id),
    projectName: team.project.name,
    teamId: parseTeamId(channel.teamId),
    teamName: team.name,
    unreadCount,
    // sp-channels: lifecycle fields
    topic: channel.topic ?? null,
    description: channel.description ?? null,
    archivedAt: channel.archivedAt?.toISOString() ?? null,
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
  }
}

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
  try {
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
      include: channelTeamInclude,
    })
    return mapChannelRecord(prisma, channel, input.currentUserId)
  } catch (err) {
    // Race condition: another request created the channel between our read and write.
    // The unique index on dmKey guarantees exactly one winner; losers re-fetch.
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
    include: channelTeamInclude,
  })

  return mapChannelRecord(prisma, channel, input.currentUserId)
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

  // Enforce tenant hierarchy: team's project must belong to the same org
  if (!(await validateTenantHierarchy(prisma, input.organizationId, input.teamId))) {
    return null
  }

  const channel = await prisma.channel.create({
    data: {
      label,
      organizationId: input.organizationId,
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
    data.label = validateChannelLabel(input.label)
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
