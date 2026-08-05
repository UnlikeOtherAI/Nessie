import { Prisma } from '@prisma/client'
import type { Channel, PrismaClient } from '@prisma/client'
import {
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  parseThreadId,
  parseUserId,
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

export type TeamProjectScope = {
  projectId: string
  projectName: string
  teamName: string
}

export const resolveDmUserId = (
  channel: Pick<Channel, 'dmKey' | 'systemChannelType' | 'type'>,
  userId?: string,
): ReturnType<typeof parseUserId> | null => {
  if (channel.type !== 'dm' || channel.systemChannelType || !channel.dmKey || !userId) {
    return null
  }

  const participantIds = channel.dmKey.split(':').slice(2)
  if (participantIds.includes('agent')) {
    return null
  }
  const targetId = participantIds.find((candidate) => candidate !== userId) ?? participantIds[0]
  return targetId ? parseUserId(targetId) : null
}

// Shared include so create/upsert sites return the channel's team + project in
// one query — mapChannelRecord then never needs a follow-up team lookup.
export const channelTeamInclude = {
  team: {
    select: {
      name: true,
      project: {
        select: { id: true, name: true },
      },
    },
  },
} satisfies Prisma.ChannelInclude

export const loadTeamProjectScope = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    teamId: string
  },
): Promise<TeamProjectScope | null> => {
  const team = await prisma.team.findUnique({
    where: { id: input.teamId },
    select: {
      name: true,
      project: {
        select: {
          id: true,
          name: true,
          organizationId: true,
        },
      },
    },
  })

  if (!team || team.project.organizationId !== input.organizationId) {
    return null
  }

  return {
    projectId: team.project.id,
    projectName: team.project.name,
    teamName: team.name,
  }
}

export const loadUnreadCountsByThread = async (
  prisma: PrismaClient,
  threadIds: string[],
  userId: string,
): Promise<Map<string, number>> => {
  if (threadIds.length === 0) {
    return new Map()
  }

  // The author and read-cursor predicates live in the JOIN's ON clause, not in a
  // CASE over the joined rows: that way Postgres walks only the unread tail via
  // the messages (thread_id, created_at) index instead of joining a thread's
  // entire history and discarding most of it. This runs on the channel-list hot
  // path, so the difference is the whole message table on a busy workspace.
  const rows = await prisma.$queryRaw<ThreadUnreadRow[]>(Prisma.sql`
    SELECT
      t.id AS thread_id,
      COUNT(m.id) AS unread_count
    FROM "threads" t
    LEFT JOIN "thread_read_states" trs
      ON trs.thread_id = t.id
      AND trs.user_id = ${userId}::uuid
    LEFT JOIN "messages" m
      ON m.thread_id = t.id
      AND (m.user_id IS NULL OR m.user_id <> ${userId}::uuid)
      AND (trs.last_read_at IS NULL OR m.created_at > trs.last_read_at)
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
  const existingThread = await prisma.thread.findFirst({
    where: { channelId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })

  if (existingThread) {
    return existingThread.id
  }

  try {
    const thread = await prisma.thread.create({
      data: { channelId, title: 'General' },
    })
    return thread.id
  } catch {
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

export const mapChannelRecord = async (
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
    slug: channel.slug,
    type: channel.type,
    systemChannelType: channel.systemChannelType ?? undefined,
    dmUserId: resolveDmUserId(channel, userId),
    visibility: channel.visibility,
    organizationId: parseOrganizationId(channel.organizationId),
    projectId: parseProjectId(team.project.id),
    projectName: team.project.name,
    teamId: parseTeamId(channel.teamId),
    teamName: team.name,
    unreadCount,
    topic: channel.topic ?? null,
    description: channel.description ?? null,
    archivedAt: channel.archivedAt?.toISOString() ?? null,
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
  }
}
