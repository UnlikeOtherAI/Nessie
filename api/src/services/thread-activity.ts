import type { Prisma, PrismaClient } from '@prisma/client'
import { buildAccessibleChannelWhere } from '@nessie/team-admin'
import { decodeKeysetCursor, encodeKeysetCursor, parseAgentId, parseChannelId, parseThreadId } from '@nessie/schemas'

import type { ThreadActivityRecord } from '../contracts.js'
import { resolveMessageViewer } from './disclosure-viewer.js'
import { evaluateMessageReadAccess } from './message-read-access.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

const activityMessageInclude = {
  user: { select: { id: true, displayName: true, avatarUrl: true, avatarAttachmentId: true } },
  basisScopes: { select: { scopeType: true, scopeId: true } },
} satisfies Prisma.MessageInclude

type ActivityMessage = Prisma.MessageGetPayload<{ include: typeof activityMessageInclude }>

const compareMessages = (left: ActivityMessage, right: ActivityMessage): number =>
  left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)

const toActivityMessage = (message: ActivityMessage) => ({
  id: message.id,
  content: message.deletedAt ? '' : message.content,
  createdAt: message.createdAt.toISOString(),
  agentId: message.agentId ? parseAgentId(message.agentId) : undefined,
  author: message.user
    ? {
        id: message.user.id,
        displayName: message.user.displayName,
        avatarUrl: message.user.avatarUrl ?? undefined,
        avatarAttachmentId: message.user.avatarAttachmentId ?? undefined,
      }
    : undefined,
})

/**
 * The Threads inbox is deliberately a separate, fail-closed read model. A
 * conversation row must be entitled at both the root and each reply; raw
 * materialised root counters would reveal withheld replies and are never used.
 */
export const listThreadActivity = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    userId: string
    cursor?: string
    limit?: number
    unreadOnly?: boolean
  },
): Promise<{
  data: { items: ThreadActivityRecord[]; unreadTotal: number }
  meta: { hasMore: boolean; nextCursor: string | null; prevCursor: string | null }
}> => {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const activeMembership = await prisma.organizationMember.findFirst({
    where: { organizationId: input.organizationId, userId: input.userId, deactivatedAt: null },
    select: { id: true },
  })
  if (!activeMembership) {
    return {
      data: { items: [], unreadTotal: 0 },
      meta: { hasMore: false, nextCursor: null, prevCursor: null },
    }
  }

  const follows = await prisma.messageThreadFollow.findMany({
    where: {
      userId: input.userId,
      rootMessage: {
        rootMessageId: null,
        thread: { channel: buildAccessibleChannelWhere(input) },
      },
    },
    include: {
      rootMessage: {
        include: {
          ...activityMessageInclude,
          replies: {
            where: { deletedAt: null, role: { not: 'system' } },
            include: activityMessageInclude,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
          conversationReadStates: {
            where: { userId: input.userId },
            select: { lastReadAt: true, lastReadMessageId: true },
          },
          thread: {
            select: {
              id: true,
              readStates: { where: { userId: input.userId }, select: { lastReadAt: true } },
              channel: { select: { id: true, label: true } },
            },
          },
        },
      },
    },
  })

  const viewer = await resolveMessageViewer(prisma, input.organizationId, input.userId)
  const isReadable = async (message: ActivityMessage, channelId: string): Promise<boolean> => {
    const access = await evaluateMessageReadAccess(prisma, {
      channelId,
      message,
      organizationId: input.organizationId,
      viewer,
    })
    return access.readable
  }

  const records: Array<ThreadActivityRecord & { sort: ActivityMessage }> = []
  for (const follow of follows) {
    const root = follow.rootMessage
    if (!root || root.deletedAt) continue
    const channel = root.thread.channel
    if (!(await isReadable(root, channel.id))) continue
    const visibleReplies: ActivityMessage[] = []
    for (const reply of root.replies) {
      if (await isReadable(reply, channel.id)) visibleReplies.push(reply)
    }
    // Activity is somebody else's readable reply. An authored root or own
    // reply creates a follow but must not create a notification for its author.
    const externalReplies = visibleReplies.filter((reply) => reply.userId !== input.userId)
    const latestReply = externalReplies.at(-1)
    if (!latestReply) continue
    const state = root.conversationReadStates[0]
    const legacy = root.thread.readStates[0]
    const watermarkAt = state?.lastReadAt ?? legacy?.lastReadAt ?? new Date(0)
    const watermarkId = state?.lastReadMessageId ?? ''
    const unread = compareMessages(latestReply, { ...latestReply, createdAt: watermarkAt, id: watermarkId }) > 0
    records.push({
      rootMessageId: root.id,
      threadId: parseThreadId(root.thread.id),
      channelId: parseChannelId(channel.id),
      channelLabel: channel.label,
      root: toActivityMessage(root),
      latestReply: toActivityMessage(latestReply),
      // The Threads inbox cannot reveal that an otherwise withheld reply
      // exists. Its count is therefore the same disclosure-filtered set it
      // renders and uses for unread state.
      replyCount: visibleReplies.length,
      unread,
      sort: latestReply,
    })
  }

  records.sort((left, right) => compareMessages(right.sort, left.sort))
  const activity = input.unreadOnly ? records.filter((record) => record.unread) : records
  const cursor = decodeKeysetCursor(input.cursor)
  const filtered = cursor
    ? activity.filter((record) =>
      compareMessages(record.sort, { ...record.sort, createdAt: cursor.createdAt, id: cursor.id }) < 0,
    )
    : activity
  const page = filtered.slice(0, limit)
  const first = page.at(0)
  const last = page.at(-1)
  const hasMore = filtered.length > limit
  return {
    data: {
      items: page.map(({ sort: _sort, ...record }) => record),
      unreadTotal: records.filter((record) => record.unread).length,
    },
    meta: {
      hasMore,
      nextCursor: hasMore && last ? encodeKeysetCursor(last.sort) : null,
      prevCursor: cursor && first ? encodeKeysetCursor(first.sort) : null,
    },
  }
}
