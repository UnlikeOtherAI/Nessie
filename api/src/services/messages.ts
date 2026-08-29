import { Prisma } from '@prisma/client'
import type { ChannelSystemType, PrismaClient, Thread } from '@prisma/client'
import {
  buildPrefixTsQuery,
  canUserReadDisclosureBasis,
  partitionByDisclosure,
  viewerSatisfiesBasis,
} from '@nessie/runtime'
import { resolveMessageViewer } from './disclosure-viewer.js'
import { resolveGrantedScopeKeys } from './disclosure-grants.js'
import {
  parseAgentId,
  parseChannelId,
  parseThreadId,
  parseUserId,
} from '@nessie/schemas'
import type { MessageSearchResult, ThreadMessageRecord } from '../contracts.js'

export type { ChannelAgent, CreateThreadMessageResult } from './message-create.js'

// Hydrate every message with its reactions and the authoring user's identity so
// the client can render the real sender name + avatar without a second lookup.
// `select` keeps the user payload to just the avatar-source fields.
export const messageInclude = {
  reactions: true,
  user: {
    select: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
      avatarAttachmentId: true,
    },
  },
  // Disclosure basis: zero rows means unrestricted, which is the common case.
  // Loaded with the message so the list can withhold content the caller is not
  // entitled to without a second round trip.
  basisScopes: { select: { scopeType: true, scopeId: true } },
} satisfies Prisma.MessageInclude

export type MessageWithReactions = Prisma.MessageGetPayload<{
  include: typeof messageInclude
}>

/**
 * How many attachments each of these messages carries.
 *
 * One grouped query per page — the feed previously mounted an attachment fetch
 * per rendered row, so a 200-message channel issued 200 requests to learn that
 * 199 of them had nothing. `Attachment.messageId` is deliberately a bare
 * indexed column with no FK relation (adding one would change delete
 * semantics), so this groups by that column rather than using an include.
 */
export const loadAttachmentCounts = async (
  prisma: PrismaClient,
  messageIds: string[],
): Promise<Map<string, number>> => {
  if (messageIds.length === 0) {
    return new Map()
  }
  const rows = await prisma.attachment.groupBy({
    by: ['messageId'],
    where: { messageId: { in: messageIds } },
    _count: { _all: true },
  })
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (row.messageId) {
      counts.set(row.messageId, row._count._all)
    }
  }
  return counts
}

const mapThreadMessageRecord = (
  message: MessageWithReactions,
  // Omitted when the caller genuinely cannot know: the client then falls back
  // to fetching the attachment list, so a real attachment is never hidden.
  attachmentCount?: number,
  // True when the caller does not satisfy this message's disclosure basis. The
  // row is still returned — the client renders a placeholder — but never its
  // content. Withholding the row entirely would leave an unexplained gap.
  withheld = false,
  // Whether the caller satisfies the basis *directly*, rather than through a
  // grant someone gave them. Only a direct reader may share onward: a grant
  // recipient's share is refused by the server anyway, so offering them the
  // control was an affordance that could only fail. Defaults true for callers
  // that cannot distinguish, which is the pre-existing behaviour.
  readableWithoutGrant = true,
): ThreadMessageRecord => ({
  attachmentCount: withheld ? 0 : attachmentCount,
  ...(withheld
    ? { restricted: true as const }
    : message.basisScopes.length > 0 && readableWithoutGrant
      // Readable on their own entitlement, and drew on restricted sources — so
      // this reader is the one who can share it. Private material offers no
      // standing rule.
      ? {
          restrictedSources: true as const,
          canShareStanding: !message.basisScopes.some((s) => s.scopeType === 'user'),
        }
      : {}),
  id: message.id,
  threadId: parseThreadId(message.threadId),
  agentId: message.agentId ? parseAgentId(message.agentId) : undefined,
  userId: message.userId ? parseUserId(message.userId) : undefined,
  author: message.user
    ? {
        id: message.user.id,
        displayName: message.user.displayName,
        avatarUrl: message.user.avatarUrl ?? undefined,
        avatarAttachmentId: message.user.avatarAttachmentId ?? undefined,
      }
    : undefined,
  role: message.role,
  // Soft-deleted rows are returned as tombstones — content is already blanked
  // at delete time, but never surface stale content even if that changes.
  // A withheld message is the same shape: the row exists, the content does not.
  content: message.deletedAt || withheld ? '' : message.content,
  createdAt: message.createdAt.toISOString(),
  // Reply threads (#233): set on replies; the materialized reply metadata is
  // carried on root messages.
  rootMessageId: message.rootMessageId ?? undefined,
  replyCount: message.replyCount,
  lastReplyAt: message.lastReplyAt ? message.lastReplyAt.toISOString() : undefined,
  editedAt: message.editedAt ? message.editedAt.toISOString() : null,
  deletedAt: message.deletedAt ? message.deletedAt.toISOString() : null,
  // Metadata is derived from the content it accompanies — tool activity, watch
  // status text, run-stop reasons, document references, embed ids — and the
  // admin renders cards from it *outside* the placeholder branch, including an
  // actionable Continue button. A withheld row carries none of it.
  metadata:
    !withheld
    && message.metadata
    && typeof message.metadata === 'object'
    && !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : undefined,
  // The social envelope names people, not just volume: who reacted to material
  // you cannot read, and who is in the sub-conversation about it. `replyCount`
  // and `lastReplyAt` stay — replies carry their own basis and are gated
  // independently, so a reader may well be entitled to some of them, and a
  // placeholder that admits a conversation exists is honest.
  replyParticipantIds: withheld ? [] : message.replyParticipantIds,
  reactions: withheld ? [] : message.reactions.map((r) => ({
    id: r.id,
    messageId: r.messageId,
    agentId: r.agentId ? parseAgentId(r.agentId) : undefined,
    userId: r.userId ? parseUserId(r.userId) : undefined,
    emoji: r.emoji,
    createdAt: r.createdAt.toISOString(),
  })),
})

// ─── sp-messaging slice: mention resolution lives in message-create.ts ─────

export const findThreadForUser = async (
  prisma: PrismaClient,
  threadId: string,
  userId: string,
  organizationId: string,
): Promise<
  (Thread & {
    channel: {
      id: string
      organizationId: string
      type: 'dm' | 'standard'
      systemChannelType: ChannelSystemType | null
    }
  }) | null
> =>
  prisma.thread.findFirst({
    where: {
      id: threadId,
      channel: {
        organizationId,
        OR: [
          { visibility: 'public' },
          { members: { some: { userId } } },
        ],
      },
    },
    include: {
      channel: {
        select: {
          id: true,
          organizationId: true,
          type: true,
          systemChannelType: true,
        },
      },
    },
  })

const DEFAULT_MESSAGE_PAGE_SIZE = 50
const MAX_MESSAGE_PAGE_SIZE = 200

const parseMessageCursor = (
  raw: string,
): { cursorDate: Date; cursorId: string } | null => {
  const [isoPart, idPart] = raw.split('|')
  if (!isoPart || !idPart) return null
  const date = new Date(isoPart)
  if (Number.isNaN(date.getTime())) return null
  return { cursorDate: date, cursorId: idPart }
}

export type ListThreadMessagesPage = {
  data: ThreadMessageRecord[]
  meta: {
    cursor: string | null
    hasMore: boolean
  }
}

export const listThreadMessages = async (
  prisma: PrismaClient,
  threadId: string,
  options: {
    before?: string
    after?: string
    limit?: number
    senderId?: string
    rootMessageId?: string
    /**
     * Who is reading. Required for the disclosure predicate; omitting them
     * yields an autonomous viewer, which sees unrestricted messages only.
     */
    organizationId?: string
    viewerUserId?: string
  } = {},
): Promise<ListThreadMessagesPage> => {
  const limit = Math.min(options.limit ?? DEFAULT_MESSAGE_PAGE_SIZE, MAX_MESSAGE_PAGE_SIZE)

  // Internal `system`-role messages (e.g. the personal assistant's scheduled
  // kickoff prompt) drive a run but are never rendered in the thread feed.
  // The default feed lists top-level posts only (rootMessageId null); passing
  // a root id lists that root's replies (#233).
  const where: Prisma.MessageWhereInput = {
    threadId,
    role: { not: 'system' },
    rootMessageId: options.rootMessageId ?? null,
  }
  const andClauses: Prisma.MessageWhereInput[] = []

  if (options.before) {
    const parsed = parseMessageCursor(options.before)
    if (parsed) {
      andClauses.push({
        OR: [
          { createdAt: { lt: parsed.cursorDate } },
          { createdAt: parsed.cursorDate, id: { lt: parsed.cursorId } },
        ],
      })
    }
  }

  // `before`/`after` may also be plain ISO timestamps (createdAt range filter),
  // distinct from the keyset cursor encoding "iso|id". A keyset cursor parse
  // already consumed `before`; otherwise treat it as a range bound.
  if (options.after) {
    const afterDate = new Date(options.after)
    if (!Number.isNaN(afterDate.getTime())) {
      andClauses.push({ createdAt: { gt: afterDate } })
    }
  }
  if (options.senderId) {
    andClauses.push({
      OR: [{ userId: options.senderId }, { agentId: options.senderId }],
    })
  }

  if (andClauses.length > 0) {
    where.AND = andClauses
  }

  // Keyset pagination over (createdAt, id). We fetch the newest page first
  // (DESC) so an empty `before` returns the most recent messages, then reverse
  // to ascending for the response so the UI renders chronologically.
  const rows = await prisma.message.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    include: messageInclude,
  })

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const oldest = page.at(-1)
  const attachmentCounts = await loadAttachmentCounts(prisma, page.map((row) => row.id))

  // Disclosure predicate: a caller who does not satisfy a message's basis gets
  // the row without its content, so the feed shows a placeholder rather than an
  // unexplained hole.
  const viewer = options.organizationId
    ? await resolveMessageViewer(prisma, options.organizationId, options.viewerUserId)
    : ({ kind: 'autonomous' } as const)

  // Grants are consulted only for the messages the predicate would otherwise
  // withhold, so an unrestricted page costs no extra queries at all.
  const provisional = partitionByDisclosure(page, viewer)
  const grantChannelId = provisional.withheld.length > 0
    ? (await prisma.thread.findUnique({
      where: { id: threadId },
      select: { channelId: true },
    }))?.channelId ?? null
    : null
  const withheldIds = new Set<string>()
  // Everything the predicate admitted without consulting grants is read on the
  // caller's own entitlement, so it stays shareable.
  const grantOnlyIds = new Set<string>()
  for (const row of provisional.withheld) {
    const granted = options.organizationId && viewer.kind === 'user' && grantChannelId
      ? await resolveGrantedScopeKeys(prisma, {
        agentId: row.agentId,
        basis: row.basisScopes,
        channelId: grantChannelId,
        messageId: row.id,
        organizationId: options.organizationId,
        viewerChannelIds: viewer.scopes
          .filter((scope) => scope.scopeType === 'channel')
          .map((scope) => scope.scopeId),
        viewerUserId: viewer.userId,
      })
      : new Set<string>()
    if (viewerSatisfiesBasis(row.basisScopes, viewer, granted)) {
      // Readable only because a grant said so — readable, but not theirs to
      // pass on.
      grantOnlyIds.add(row.id)
    } else {
      withheldIds.add(row.id)
    }
  }

  return {
    data: page
      .slice()
      .reverse()
      .map((row) =>
        mapThreadMessageRecord(
          row,
          attachmentCounts.get(row.id) ?? 0,
          withheldIds.has(row.id),
          !grantOnlyIds.has(row.id),
        )),
    meta: {
      cursor: hasMore && oldest ? `${oldest.createdAt.toISOString()}|${oldest.id}` : null,
      hasMore,
    },
  }
}

export const markThreadRead = async (
  prisma: PrismaClient,
  input: {
    rootMessageId?: string
    threadId: string
    userId: string
  },
): Promise<boolean> => {
  // The original per-container cursor remains a safe baseline while existing
  // installs migrate. New acknowledgements always write the precise root
  // cursor instead, so opening reply A cannot make reply B look read.
  const legacyReadState = await prisma.threadReadState.findUnique({
    where: {
      threadId_userId: {
        threadId: input.threadId,
        userId: input.userId,
      },
    },
    select: { lastReadAt: true },
  })

  if (input.rootMessageId) {
    const root = await prisma.message.findFirst({
      where: {
        id: input.rootMessageId,
        rootMessageId: null,
        threadId: input.threadId,
      },
      select: { createdAt: true },
    })
    if (!root) return false

    const latestMessage = await prisma.message.findFirst({
      where: {
        threadId: input.threadId,
        OR: [
          { id: input.rootMessageId },
          { rootMessageId: input.rootMessageId },
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    const lastReadAt = [root.createdAt, latestMessage?.createdAt, legacyReadState?.lastReadAt]
      .filter((value): value is Date => Boolean(value))
      .reduce((latest, value) => value > latest ? value : latest)

    await prisma.messageConversationReadState.upsert({
      where: {
        rootMessageId_userId: {
          rootMessageId: input.rootMessageId,
          userId: input.userId,
        },
      },
      create: {
        rootMessageId: input.rootMessageId,
        userId: input.userId,
        lastReadAt,
      },
      update: {
        lastReadAt,
      },
    })
    return true
  }

  // The main feed shows roots but not their replies. Advance every visible
  // root only to its own creation time (or the old safe baseline), leaving
  // replies unread until their exact panel is opened.
  const baseline = legacyReadState?.lastReadAt ?? new Date(0)
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "message_conversation_read_states" (
      "id", "root_message_id", "user_id", "last_read_at", "created_at", "updated_at"
    )
    SELECT
      gen_random_uuid(),
      m.id,
      ${input.userId}::uuid,
      GREATEST(m.created_at, ${baseline}),
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM "messages" m
    WHERE m.thread_id = ${input.threadId}::uuid
      AND m.root_message_id IS NULL
    ON CONFLICT ("root_message_id", "user_id") DO UPDATE
      SET "last_read_at" = GREATEST(
        "message_conversation_read_states"."last_read_at",
        EXCLUDED."last_read_at"
      ),
      "updated_at" = CURRENT_TIMESTAMP
  `)
  return true
}

// ─── sp-messaging slice: edit, soft-delete, full-text search ───────────────

export type UpdateMessageResult =
  | { kind: 'updated'; message: MessageWithReactions }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }

export const updateMessage = async (
  prisma: PrismaClient,
  input: { messageId: string; threadId: string; userId: string; content: string },
): Promise<UpdateMessageResult> => {
  const existing = await prisma.message.findFirst({
    where: { id: input.messageId, threadId: input.threadId },
    select: { id: true, userId: true, deletedAt: true },
  })
  if (!existing || existing.deletedAt) {
    return { kind: 'not_found' }
  }
  // Author-only edit.
  if (existing.userId !== input.userId) {
    return { kind: 'forbidden' }
  }

  const message = await prisma.message.update({
    where: { id: input.messageId },
    data: { content: input.content, editedAt: new Date() },
    include: messageInclude,
  })
  return { kind: 'updated', message }
}

export type SoftDeleteMessageResult =
  | { kind: 'deleted'; message: MessageWithReactions }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }

export const softDeleteMessage = async (
  prisma: PrismaClient,
  input: {
    messageId: string
    threadId: string
    userId: string
    isChannelManager: boolean
  },
): Promise<SoftDeleteMessageResult> => {
  const existing = await prisma.message.findFirst({
    where: { id: input.messageId, threadId: input.threadId },
    select: { id: true, userId: true, deletedAt: true },
  })
  if (!existing || existing.deletedAt) {
    return { kind: 'not_found' }
  }
  // Author or channel manager may delete.
  if (existing.userId !== input.userId && !input.isChannelManager) {
    return { kind: 'forbidden' }
  }

  const message = await prisma.message.update({
    where: { id: input.messageId },
    // Blank the content for privacy; the row remains so the UI can render a
    // tombstone and pagination keysets stay stable.
    data: { deletedAt: new Date(), content: '' },
    include: messageInclude,
  })
  return { kind: 'deleted', message }
}

export const mapMessageRecord = (
  message: MessageWithReactions,
  attachmentCount?: number,
): ThreadMessageRecord => mapThreadMessageRecord(message, attachmentCount)

/** `mapMessageRecord` for a single row whose attachment count is not yet known. */
export const mapMessageRecordWithAttachments = async (
  prisma: PrismaClient,
  message: MessageWithReactions,
  // Who is reading, for the disclosure predicate. The list endpoint has always
  // withheld restricted content; this single-message read did not, because the
  // mapper was called with two arguments and `withheld` fell to its `false`
  // default — handing the caller the verbatim content of a reply they are not
  // entitled to, plus the share affordance for it. The admin hits this route on
  // a cold deep-link into a reply thread, so it was reachable from the product.
  // Omitting `viewer` keeps the unrestricted behaviour for internal callers that
  // have already authorized the read.
  viewer?: { channelId: string; organizationId: string; userId: string },
): Promise<ThreadMessageRecord> => {
  const counts = await loadAttachmentCounts(prisma, [message.id])
  const count = counts.get(message.id) ?? 0
  if (!viewer || message.basisScopes.length === 0) {
    return mapThreadMessageRecord(message, count)
  }
  // Two questions, not one: may they read it, and is that on their own
  // entitlement? A grant recipient reads it but may not pass it on.
  const messageViewer = await resolveMessageViewer(
    prisma,
    viewer.organizationId,
    viewer.userId,
  )
  const direct = viewerSatisfiesBasis(message.basisScopes, messageViewer)
  if (direct) {
    return mapThreadMessageRecord(message, count, false, true)
  }
  const readable = await canUserReadDisclosureBasis(prisma, {
    agentId: message.agentId,
    basis: message.basisScopes,
    channelId: viewer.channelId,
    messageId: message.id,
    organizationId: viewer.organizationId,
    userId: viewer.userId,
  })
  return mapThreadMessageRecord(message, count, !readable, false)
}

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
