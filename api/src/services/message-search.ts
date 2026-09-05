import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { buildPrefixTsQuery } from '@nessie/runtime'
import { parseAgentId, parseChannelId, parseThreadId } from '@nessie/schemas'

import type { MessageSearchResult } from '../contracts.js'

/**
 * Full-text search across the channels a caller can see.
 *
 * A separate read from the thread feed rather than a mode of it: it spans
 * channels instead of one thread, answers with snippets instead of rows, and —
 * because a snippet list has nowhere to render a withheld placeholder — it
 * fails **closed** on disclosure rather than withholding
 * ([docs/standards/disclosure-boundaries.md](../../../docs/standards/disclosure-boundaries.md)).
 */

type MessageSearchRow = {
  id: string
  thread_id: string
  channel_id: string
  channel_label: string
  content: string
  created_at: Date
  agent_id: string | null
  user_id: string | null
  author_name: string | null
}

const buildSearchSnippet = (content: string, query: string, maxLength = 180): string => {
  const trimmed = query.trim().toLowerCase()
  const lower = content.toLowerCase()
  const index = trimmed ? lower.indexOf(trimmed.split(/\s+/)[0] ?? '') : -1
  if (index < 0) {
    return content.length <= maxLength ? content : `${content.slice(0, maxLength - 1)}…`
  }
  const half = Math.floor(maxLength / 2)
  const start = Math.max(0, index - half)
  const end = Math.min(content.length, index + half)
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`
}

export const searchMessages = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    userId: string
    isOwner: boolean
    query: string
    channelId?: string
    senderId?: string
    before?: string
    after?: string
    limit?: number
  },
): Promise<MessageSearchResult[]> => {
  const limit = Math.min(input.limit ?? 25, 100)

  // Channels the caller can see — public, or ones they are a member of. Owners
  // see every channel in the organization.
  const channels = await prisma.channel.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.isOwner
        ? {}
        : { OR: [{ visibility: 'public' }, { members: { some: { userId: input.userId } } }] }),
      ...(input.channelId ? { id: input.channelId } : {}),
    },
    select: { id: true },
  })
  const channelIds = channels.map((c) => c.id)
  if (channelIds.length === 0) {
    return []
  }

  const prefixQuery = buildPrefixTsQuery(input.query)
  if (!prefixQuery) {
    return []
  }

  const conditions: Prisma.Sql[] = [
    Prisma.sql`m."deleted_at" IS NULL`,
    Prisma.sql`t."channel_id" IN (${Prisma.join(
      channelIds.map((id) => Prisma.sql`${id}::uuid`),
    )})`,
    Prisma.sql`to_tsvector('english', m."content") @@ to_tsquery('english', ${prefixQuery})`,
    // Fail closed on disclosure. Search returns content snippets scoped by
    // channel membership alone, and unlike the thread list it has nowhere to
    // render a withheld placeholder — so anything carrying a basis is excluded
    // outright rather than evaluated. Every other disclosure hole needs an agent
    // or a race; this one is a text box. Entitlement-aware search can relax this
    // once the predicate is expressible in SQL.
    Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "message_basis_scopes" mbs WHERE mbs."message_id" = m."id"
    )`,
  ]
  if (input.senderId) {
    conditions.push(
      Prisma.sql`(m."user_id" = ${input.senderId}::uuid OR m."agent_id" = ${input.senderId}::uuid)`,
    )
  }
  if (input.before) {
    const beforeDate = new Date(input.before)
    if (!Number.isNaN(beforeDate.getTime())) {
      conditions.push(Prisma.sql`m."created_at" < ${beforeDate}`)
    }
  }
  if (input.after) {
    const afterDate = new Date(input.after)
    if (!Number.isNaN(afterDate.getTime())) {
      conditions.push(Prisma.sql`m."created_at" > ${afterDate}`)
    }
  }

  const rows = await prisma.$queryRaw<MessageSearchRow[]>(Prisma.sql`
    SELECT
      m."id",
      m."thread_id",
      c."id" AS channel_id,
      c."label" AS channel_label,
      m."content",
      m."created_at",
      m."agent_id",
      m."user_id",
      COALESCE(u."display_name", a."name") AS author_name
    FROM "messages" m
    JOIN "threads" t ON t."id" = m."thread_id"
    JOIN "channels" c ON c."id" = t."channel_id"
    LEFT JOIN "users" u ON u."id" = m."user_id"
    LEFT JOIN "agents" a ON a."id" = m."agent_id"
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY m."created_at" DESC
    LIMIT ${limit}
  `)

  return rows.map((row) => ({
    id: row.id,
    threadId: parseThreadId(row.thread_id),
    channelId: parseChannelId(row.channel_id),
    channelLabel: row.channel_label,
    snippet: buildSearchSnippet(row.content, input.query),
    createdAt: row.created_at.toISOString(),
    authorName: row.author_name ?? 'Unknown',
    agentId: row.agent_id ? parseAgentId(row.agent_id) : undefined,
    userId: row.user_id ?? undefined,
  }))
}
