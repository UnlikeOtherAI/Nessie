import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { toVectorLiteral } from '@nessie/retrieval'
import { buildPrefixTsQuery } from '@nessie/runtime'
import {
  EMBEDDING_DIMENSIONS,
  parseAgentId,
  parseChannelId,
  parseThreadId,
} from '@nessie/schemas'

import type { MessageSearchResult } from '../contracts/messaging.js'

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
    query: string
    channelId?: string
    senderId?: string
    before?: string
    after?: string
    limit?: number
    /** Semantic is hybrid: vector and full-text ranks are fused. */
    mode?: 'fulltext' | 'semantic'
    embeddingModel?: string | null
    queryEmbedding?: number[] | null
  },
): Promise<MessageSearchResult[]> => {
  const limit = Math.min(input.limit ?? 25, 100)

  // Search reach is the same for every role, organisation and team owners and
  // admins included: public standard channels, plus the conversations the
  // searcher is a member of. A direct message or a system room (Personal
  // Assistant, agent mailbox, external agent) is participant-only even when its
  // visibility column says public. Owners used to skip this filter entirely,
  // which returned snippets from other people's DMs and assistant rooms.
  // The channel read predicate (`getVisibleChannel`, api/src/lib/request-helpers.ts)
  // must stay aligned with this rule, including that a soft-deleted channel (a
  // deleted channel, or any channel of a deleted project) is gone for everyone.
  const channels = await prisma.channel.findMany({
    where: {
      organizationId: input.organizationId,
      deletedAt: null,
      OR: [
        { type: 'standard', systemChannelType: null, visibility: 'public' },
        { members: { some: { userId: input.userId } } },
      ],
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

  const eligibility: Prisma.Sql[] = [
    Prisma.sql`m."deleted_at" IS NULL`,
    Prisma.sql`m."role" <> 'system'`,
    Prisma.sql`t."channel_id" IN (${Prisma.join(
      channelIds.map((id) => Prisma.sql`${id}::uuid`),
    )})`,
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
    eligibility.push(
      Prisma.sql`(m."user_id" = ${input.senderId}::uuid OR m."agent_id" = ${input.senderId}::uuid)`,
    )
  }
  if (input.before) {
    const beforeDate = new Date(input.before)
    if (!Number.isNaN(beforeDate.getTime())) {
      eligibility.push(Prisma.sql`m."created_at" < ${beforeDate}`)
    }
  }
  if (input.after) {
    const afterDate = new Date(input.after)
    if (!Number.isNaN(afterDate.getTime())) {
      eligibility.push(Prisma.sql`m."created_at" > ${afterDate}`)
    }
  }

  const vector = input.mode === 'semantic'
    ? toVectorLiteral(input.queryEmbedding ?? null)
    : null
  const candidateLimit = Math.min(limit * 4, 400)

  const rows = await prisma.$queryRaw<MessageSearchRow[]>(Prisma.sql`
    WITH eligible AS (
      SELECT
        m."id",
        m."thread_id",
        c."id" AS channel_id,
        c."label" AS channel_label,
        m."content",
        m."created_at",
        m."agent_id",
        m."user_id",
        COALESCE(u."display_name", a."name") AS author_name,
        to_tsvector('english', m."content") AS search_document
      FROM "messages" m
      JOIN "threads" t ON t."id" = m."thread_id"
      JOIN "channels" c ON c."id" = t."channel_id"
      LEFT JOIN "users" u ON u."id" = m."user_id"
      LEFT JOIN "agents" a ON a."id" = m."agent_id"
      WHERE ${Prisma.join(eligibility, ' AND ')}
    ), lexical AS (
      SELECT e."id", row_number() OVER (
        ORDER BY ts_rank_cd(e.search_document, query) DESC, e."created_at" DESC, e."id"
      ) AS rank
      FROM eligible e, to_tsquery('english', ${prefixQuery}) query
      WHERE e.search_document @@ query
      ORDER BY ts_rank_cd(e.search_document, query) DESC, e."created_at" DESC, e."id"
      LIMIT ${candidateLimit}
    ), semantic AS (
      SELECT e."id", row_number() OVER (
        ORDER BY me."embedding" <=> ${vector}::vector, e."created_at" DESC, e."id"
      ) AS rank
      FROM eligible e
      JOIN "message_embeddings" me ON me."message_id" = e."id"
      WHERE ${vector}::vector IS NOT NULL
        AND me."status" = 'indexed'
        AND me."embedding" IS NOT NULL
        AND me."embedding_model" = ${input.embeddingModel ?? null}
        AND me."dims" = ${EMBEDDING_DIMENSIONS}
        AND 1 - (me."embedding" <=> ${vector}::vector) >= 0.3
      ORDER BY me."embedding" <=> ${vector}::vector, e."created_at" DESC, e."id"
      LIMIT ${candidateLimit}
    ), ranked AS (
      SELECT
        COALESCE(lexical."id", semantic."id") AS id,
        lexical.rank AS lexical_rank,
        semantic.rank AS semantic_rank
      FROM lexical FULL OUTER JOIN semantic ON semantic."id" = lexical."id"
    )
    SELECT
      e."id",
      e."thread_id",
      e.channel_id,
      e.channel_label,
      e."content",
      e."created_at",
      e."agent_id",
      e."user_id",
      e.author_name
    FROM ranked r
    JOIN eligible e ON e."id" = r.id
    ORDER BY
      (COALESCE(1.0 / (60 + r.lexical_rank), 0)
        + COALESCE(1.0 / (60 + r.semantic_rank), 0)) DESC,
      e."created_at" DESC,
      e."id"
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
