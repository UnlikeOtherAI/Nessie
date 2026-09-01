import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { visibleUserAlertWhere } from '@nessie/db'

type UnreadMessageRow = { unread_count: bigint | number }

// The native badge is one total across Channels, Projects, and Knowledge. It
// deliberately reuses the same message-read and alert-visibility predicates
// as the app surfaces, so a lock-screen delivery never overwrites the icon
// with a partial subtotal.
export type PushBadgePrisma = Pick<PrismaClient, '$queryRaw' | 'userAlert'>

const unreadMessageCount = async (
  prisma: PushBadgePrisma,
  input: { organizationId: string; userId: string },
): Promise<number> => {
  const rows = await prisma.$queryRaw<UnreadMessageRow[]>(Prisma.sql`
    SELECT COUNT(m.id) AS unread_count
    FROM "messages" m
    JOIN "threads" t ON t.id = m.thread_id
    JOIN "channels" c ON c.id = t.channel_id
    LEFT JOIN "channel_members" cm
      ON cm.channel_id = c.id
      AND cm.user_id = ${input.userId}::uuid
    LEFT JOIN "thread_read_states" trs
      ON trs.thread_id = t.id
      AND trs.user_id = ${input.userId}::uuid
    LEFT JOIN "message_conversation_read_states" mcrs
      ON mcrs.user_id = ${input.userId}::uuid
      AND mcrs.root_message_id = COALESCE(m.root_message_id, m.id)
    WHERE c.organization_id = ${input.organizationId}::uuid
      AND c.archived_at IS NULL
      AND (c.visibility = 'public' OR cm.id IS NOT NULL)
      AND (m.user_id IS NULL OR m.user_id <> ${input.userId}::uuid)
      AND (
        COALESCE(mcrs.last_read_at, trs.last_read_at) IS NULL
        OR m.created_at > COALESCE(mcrs.last_read_at, trs.last_read_at)
      )
  `)
  const count = rows[0]?.unread_count ?? 0
  return typeof count === 'bigint' ? Number(count) : count
}

export const loadPushBadgeCount = async (
  prisma: PushBadgePrisma,
  input: { organizationId: string; userId: string },
): Promise<number> => {
  const [messages, attention] = await Promise.all([
    unreadMessageCount(prisma, input),
    prisma.userAlert.count({
      where: {
        ...visibleUserAlertWhere(input),
        kind: { in: ['task_assigned', 'knowledge_published'] },
        readAt: null,
      },
    }),
  ])
  return Math.max(0, Math.floor(messages + attention))
}
