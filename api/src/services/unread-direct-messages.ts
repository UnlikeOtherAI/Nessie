import { Prisma, type PrismaClient } from '@prisma/client'
import {
  parseChannelId,
  UnreadDirectMessageRecordSchema,
  type UnreadDirectMessageRecord,
} from '@nessie/schemas'

import { listChannelsForUser } from './channels.js'
import { resolveMessageViewer } from './disclosure-viewer.js'
import { evaluateMessageReadAccess } from './message-read-access.js'

type UnreadMessageRow = {
  message_id: string
  thread_id: string
}

const previewMessageInclude = {
  basisScopes: { select: { scopeId: true, scopeType: true } },
} satisfies Prisma.MessageInclude

/**
 * The direct-message inbox is a projection of the existing channel read
 * cursors, not a second unread store. A conversation cursor takes precedence
 * for replies; the container cursor remains the safe baseline for every other
 * message.
 */
const findLatestUnreadMessageByThread = async (
  prisma: PrismaClient,
  input: { threadIds: string[]; userId: string },
): Promise<Map<string, string>> => {
  if (input.threadIds.length === 0) return new Map()

  const rows = await prisma.$queryRaw<UnreadMessageRow[]>(Prisma.sql`
    SELECT DISTINCT ON (m.thread_id)
      m.id AS message_id,
      m.thread_id
    FROM "messages" m
    LEFT JOIN "thread_read_states" trs
      ON trs.thread_id = m.thread_id
      AND trs.user_id = ${input.userId}::uuid
    LEFT JOIN "message_conversation_read_states" mcrs
      ON mcrs.user_id = ${input.userId}::uuid
      AND mcrs.root_message_id = COALESCE(m.root_message_id, m.id)
    WHERE m.thread_id IN (${Prisma.join(input.threadIds.map((threadId) => Prisma.sql`${threadId}::uuid`))})
      AND m.role <> 'system'
      AND (m.user_id IS NULL OR m.user_id <> ${input.userId}::uuid)
      AND m.created_at > COALESCE(mcrs.last_read_at, trs.last_read_at, ${new Date(0)})
    ORDER BY m.thread_id, m.created_at DESC, m.id DESC
  `)

  return new Map(rows.map((row) => [row.thread_id, row.message_id]))
}

export const listUnreadDirectMessages = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string },
): Promise<UnreadDirectMessageRecord[]> => {
  const channels = await listChannelsForUser(
    prisma,
    input.userId,
    input.organizationId,
  )
  const unreadChannels = channels.filter(
    (channel) => channel.type === 'dm' && channel.unreadCount > 0,
  )
  const latestMessageIdByThread = await findLatestUnreadMessageByThread(prisma, {
    threadIds: unreadChannels.map((channel) => channel.defaultThreadId),
    userId: input.userId,
  })
  if (latestMessageIdByThread.size === 0) return []

  const messages = await prisma.message.findMany({
    where: { id: { in: [...latestMessageIdByThread.values()] } },
    include: previewMessageInclude,
  })
  const messagesById = new Map(messages.map((message) => [message.id, message]))
  const viewer = await resolveMessageViewer(prisma, input.organizationId, input.userId)

  const items = await Promise.all(
    unreadChannels.map(async (channel) => {
      const messageId = latestMessageIdByThread.get(channel.defaultThreadId)
      const message = messageId ? messagesById.get(messageId) : undefined
      if (!message) return null

      const access = await evaluateMessageReadAccess(prisma, {
        channelId: channel.id,
        message,
        organizationId: input.organizationId,
        viewer,
      })
      const record = {
        channelId: parseChannelId(channel.id),
        channelLabel: channel.label,
        latestMessage: {
          content: access.readable && !message.deletedAt ? message.content : '',
          createdAt: message.createdAt.toISOString(),
          ...(message.deletedAt ? { deleted: true as const } : {}),
          ...(!access.readable ? { restricted: true as const } : {}),
        },
        unreadCount: channel.unreadCount,
      }
      return {
        record: UnreadDirectMessageRecordSchema.parse(record),
        sortAt: message.createdAt,
      }
    }),
  )

  return items
    .filter((item): item is { record: UnreadDirectMessageRecord; sortAt: Date } => item !== null)
    .sort((left, right) => right.sortAt.getTime() - left.sortAt.getTime())
    .map((item) => item.record)
}
