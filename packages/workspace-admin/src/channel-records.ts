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
import type { ChannelRecord } from '@nessie/schemas'

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

type ThreadLastMessageRow = {
  thread_id: string
  last_message_at: Date | null
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
  if (participantIds.length !== 2) {
    return null
  }
  const targetId = participantIds.find((candidate) => candidate !== userId) ?? participantIds[0]
  return targetId ? parseUserId(targetId) : null
}

export const isGroupDm = (
  channel: Pick<Channel, 'dmKey' | 'systemChannelType' | 'type'>,
): boolean =>
  channel.type === 'dm'
  && !channel.systemChannelType
  && channel.dmKey?.split(':')[2] === 'group'

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

  // A reply panel is an exact conversation, not the container thread. Each
  // message therefore resolves its root (a top-level post is its own root) and
  // reads that root's cursor first. The old container cursor remains a
  // deployment-safe baseline for roots that have not been opened since this
  // more precise model shipped.
  const rows = await prisma.$queryRaw<ThreadUnreadRow[]>(Prisma.sql`
    SELECT
      t.id AS thread_id,
      COUNT(m.id) FILTER (
        WHERE COALESCE(mcrs.last_read_at, trs.last_read_at) IS NULL
          OR m.created_at > COALESCE(mcrs.last_read_at, trs.last_read_at)
      ) AS unread_count
    FROM "threads" t
    LEFT JOIN "thread_read_states" trs
      ON trs.thread_id = t.id
      AND trs.user_id = ${userId}::uuid
    LEFT JOIN "messages" m
      ON m.thread_id = t.id
      AND (m.user_id IS NULL OR m.user_id <> ${userId}::uuid)
    LEFT JOIN "message_conversation_read_states" mcrs
      ON mcrs.user_id = ${userId}::uuid
      AND mcrs.root_message_id = COALESCE(m.root_message_id, m.id)
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

// Last activity per thread: `MAX(created_at)` over the thread's messages, the
// honest source for "when did this room last say anything". It is deliberately
// a *separate* aggregate from loadUnreadCountsByThread — that query walks only
// the unread tail (its predicates live in the JOIN's ON clause for exactly that
// reason), and folding a full-history MAX into it would make it scan work it
// currently avoids. Here the messages (thread_id, created_at) index serves each
// group from its tail. Tombstoned messages still count, matching the unread
// computation: a deleted message is an event the room saw.
export const loadLastMessageAtByThread = async (
  prisma: PrismaClient,
  threadIds: string[],
): Promise<Map<string, string>> => {
  if (threadIds.length === 0) {
    return new Map()
  }

  const rows = await prisma.$queryRaw<ThreadLastMessageRow[]>(Prisma.sql`
    SELECT
      m.thread_id AS thread_id,
      MAX(m.created_at) AS last_message_at
    FROM "messages" m
    WHERE m.thread_id IN (${Prisma.join(threadIds.map((threadId) => Prisma.sql`${threadId}::uuid`))})
    GROUP BY m.thread_id
  `)

  const activity = new Map<string, string>()
  for (const row of rows) {
    if (row.last_message_at) {
      activity.set(row.thread_id, row.last_message_at.toISOString())
    }
  }
  return activity
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
  // Every emission of a channel record carries lastMessageAt, not just the list
  // read: single-channel reads and post-mutation responses flow through here
  // too, and the admin patches its cached channel list in place from those
  // responses — a record without the field would blank a row's recency the
  // moment anyone renamed or joined a channel.
  const lastMessageAt =
    (await loadLastMessageAtByThread(prisma, [defaultThreadId])).get(defaultThreadId) ?? null
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
    isGroupDm: isGroupDm(channel),
    visibility: channel.visibility,
    organizationId: parseOrganizationId(channel.organizationId),
    projectId: parseProjectId(team.project.id),
    projectName: team.project.name,
    teamId: parseTeamId(channel.teamId),
    teamName: team.name,
    unreadCount,
    lastMessageAt,
    topic: channel.topic ?? null,
    description: channel.description ?? null,
    archivedAt: channel.archivedAt?.toISOString() ?? null,
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
  }
}
