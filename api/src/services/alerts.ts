import type { Prisma, PrismaClient } from '@prisma/client'

import type { UserAlertRecord } from '../contracts.js'

// User alerts (#246): org-scoped, per-user reads of the durable UserAlert
// store. Every query is pinned to BOTH the caller's organization and the
// caller's user id — alerts are private to their recipient.

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

// Keyset cursor in the same `"<isoDate>|<id>"` shape the other list services
// (approvals/audit/messages) use.
const parseCursor = (
  raw: string | undefined,
): { cursorDate: Date; cursorId: string } | null => {
  if (!raw) return null
  const [isoPart, idPart] = raw.split('|')
  if (!isoPart || !idPart) return null
  const cursorDate = new Date(isoPart)
  if (Number.isNaN(cursorDate.getTime())) return null
  return { cursorDate, cursorId: idPart }
}

const alertInclude = {
  channel: { select: { label: true } },
  actorUser: { select: { displayName: true } },
  actorAgent: { select: { name: true } },
} satisfies Prisma.UserAlertInclude

type AlertWithRelations = Prisma.UserAlertGetPayload<{ include: typeof alertInclude }>

const mapAlertRecord = (alert: AlertWithRelations): UserAlertRecord => ({
  id: alert.id,
  kind: alert.kind,
  messageId: alert.messageId,
  threadId: alert.threadId,
  channelId: alert.channelId,
  channelLabel: alert.channel?.label ?? null,
  actorUserId: alert.actorUserId,
  actorAgentId: alert.actorAgentId,
  actorDisplayName: alert.actorUser?.displayName ?? alert.actorAgent?.name ?? null,
  readAt: alert.readAt ? alert.readAt.toISOString() : null,
  createdAt: alert.createdAt.toISOString(),
})

const unreadCount = (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string },
): Promise<number> =>
  prisma.userAlert.count({
    where: {
      organizationId: input.organizationId,
      userId: input.userId,
      readAt: null,
    },
  })

export const listUserAlerts = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    userId: string
    cursor?: string
    limit?: number
    unreadOnly?: boolean
  },
): Promise<{
  data: { alerts: UserAlertRecord[]; unreadCount: number }
  meta: { cursor: string | null; hasMore: boolean }
}> => {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const where: Prisma.UserAlertWhereInput = {
    organizationId: input.organizationId,
    userId: input.userId,
    ...(input.unreadOnly ? { readAt: null } : {}),
  }

  const cursor = parseCursor(input.cursor)
  if (cursor) {
    where['OR'] = [
      { createdAt: { lt: cursor.cursorDate } },
      { createdAt: cursor.cursorDate, id: { lt: cursor.cursorId } },
    ]
  }

  const [rows, unread] = await Promise.all([
    prisma.userAlert.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: alertInclude,
    }),
    unreadCount(prisma, input),
  ])

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]

  return {
    data: { alerts: page.map(mapAlertRecord), unreadCount: unread },
    meta: {
      cursor: hasMore && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
      hasMore,
    },
  }
}

export type MarkUserAlertsReadResult = {
  read: number
  unreadCount: number
  readAt: Date
  // Channel ids that had alerts marked read — the route fans one
  // `alert.read` realtime event per channel for cross-device sync.
  readAlerts: { id: string; channelId: string | null }[]
}

export const markUserAlertsRead = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    userId: string
    ids?: string[]
    all?: boolean
  },
): Promise<MarkUserAlertsReadResult> => {
  const where: Prisma.UserAlertWhereInput = {
    organizationId: input.organizationId,
    userId: input.userId,
    readAt: null,
    ...(input.all ? {} : { id: { in: input.ids ?? [] } }),
  }

  // Read the affected rows first so the route can publish per-channel
  // `alert.read` realtime events; updateMany returns only a count.
  const readAlerts = await prisma.userAlert.findMany({
    where,
    select: { id: true, channelId: true },
  })
  const readAt = new Date()
  if (readAlerts.length > 0) {
    await prisma.userAlert.updateMany({
      where: { id: { in: readAlerts.map((alert) => alert.id) } },
      data: { readAt },
    })
  }

  return {
    read: readAlerts.length,
    unreadCount: await unreadCount(prisma, input),
    readAt,
    readAlerts,
  }
}
