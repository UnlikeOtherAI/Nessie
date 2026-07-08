import { Prisma } from '@prisma/client'
import type { PrismaClient, Thread } from '@prisma/client'
import {
  parseAgentId,
  parseChannelId,
  parseThreadId,
  parseUserId,
} from '@nessie/schemas'
import type { MessageSearchResult, ThreadMessageRecord } from '../contracts.js'
import { buildGravatarUrl } from '../lib/gravatar.js'

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
} satisfies Prisma.MessageInclude

type MessageWithReactions = Prisma.MessageGetPayload<{ include: typeof messageInclude }>

const mapThreadMessageRecord = (message: MessageWithReactions): ThreadMessageRecord => ({
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
        gravatarUrl: buildGravatarUrl(message.user.email),
      }
    : undefined,
  role: message.role,
  // Soft-deleted rows are returned as tombstones — content is already blanked
  // at delete time, but never surface stale content even if that changes.
  content: message.deletedAt ? '' : message.content,
  createdAt: message.createdAt.toISOString(),
  editedAt: message.editedAt ? message.editedAt.toISOString() : null,
  deletedAt: message.deletedAt ? message.deletedAt.toISOString() : null,
  metadata:
    message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : undefined,
  reactions: message.reactions.map((r) => ({
    id: r.id,
    messageId: r.messageId,
    agentId: r.agentId ? parseAgentId(r.agentId) : undefined,
    userId: r.userId ? parseUserId(r.userId) : undefined,
    emoji: r.emoji,
    createdAt: r.createdAt.toISOString(),
  })),
})

// ─── sp-messaging slice: mention resolution ────────────────────────────────

export type MessageMentions = {
  userIds: string[]
  agentIds: string[]
  broadcast: 'here' | 'channel' | 'everyone' | null
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Matches a @name token, allowing the name itself to contain spaces (members
// and agents can have multi-word display names). Same boundary rule the agent
// orchestrator uses, so resolution is identical on both sides.
const mentionMatches = (content: string, name: string): boolean => {
  if (!name) return false
  const re = new RegExp(`@${escapeRegExp(name)}(?:\\s|$|[^\\w])`, 'i')
  return re.test(content)
}

export const resolveMessageMentions = (
  content: string,
  input: { members: Array<{ userId: string; displayName: string }> },
): MessageMentions => {
  const userIds: string[] = []
  let broadcast: MessageMentions['broadcast'] = null

  if (content.includes('@')) {
    for (const member of input.members) {
      if (mentionMatches(content, member.displayName)) {
        userIds.push(member.userId)
      }
    }
    // Literal broadcast tokens. `@everyone` wins over `@channel` over `@here`
    // if multiple are present, mirroring Slack's escalation order.
    if (/@everyone(?:\s|$|[^\w])/i.test(content)) {
      broadcast = 'everyone'
    } else if (/@channel(?:\s|$|[^\w])/i.test(content)) {
      broadcast = 'channel'
    } else if (/@here(?:\s|$|[^\w])/i.test(content)) {
      broadcast = 'here'
    }
  }

  return { userIds: [...new Set(userIds)], agentIds: [], broadcast }
}

export const mentionedAgentIdsFromContent = (
  content: string,
  agents: Array<{ id: string; name: string }>,
): string[] => {
  if (!content.includes('@')) return []
  const ids = agents.filter((a) => mentionMatches(content, a.name)).map((a) => a.id)
  return [...new Set(ids)]
}

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
      systemChannelType: 'personal_assistant' | null
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
  } = {},
): Promise<ListThreadMessagesPage> => {
  const limit = Math.min(options.limit ?? DEFAULT_MESSAGE_PAGE_SIZE, MAX_MESSAGE_PAGE_SIZE)

  // Internal `system`-role messages (e.g. the personal assistant's scheduled
  // kickoff prompt) drive a run but are never rendered in the thread feed.
  const where: Prisma.MessageWhereInput = { threadId, role: { not: 'system' } }
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

  return {
    data: page.slice().reverse().map(mapThreadMessageRecord),
    meta: {
      cursor: hasMore && oldest ? `${oldest.createdAt.toISOString()}|${oldest.id}` : null,
      hasMore,
    },
  }
}

export const markThreadRead = async (
  prisma: PrismaClient,
  input: {
    threadId: string
    userId: string
  },
): Promise<void> => {
  const latestMessage = await prisma.message.findFirst({
    where: { threadId: input.threadId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })

  await prisma.threadReadState.upsert({
    where: {
      threadId_userId: {
        threadId: input.threadId,
        userId: input.userId,
      },
    },
    create: {
      threadId: input.threadId,
      userId: input.userId,
      lastReadAt: latestMessage?.createdAt ?? new Date(),
    },
    update: {
      lastReadAt: latestMessage?.createdAt ?? new Date(),
    },
  })
}

export type ChannelAgent = {
  id: string
  name: string
  role: string
  systemPrompt: string | null
}

export type CreateThreadMessageResult =
  | {
      kind: 'created'
      message: MessageWithReactions
      channelAgents: ChannelAgent[]
      // Agents @mentioned in the message that are not members of the channel.
      // They are NOT dispatched; the client offers to invite them.
      pendingAgentInvites: { id: string; name: string }[]
    }
  | {
      kind: 'thread_not_found'
    }

export const createThreadMessage = async (
  prisma: PrismaClient,
  input: {
    content: string
    threadId: string
    userId: string
  },
): Promise<CreateThreadMessageResult> => {
  const thread = await prisma.thread.findUnique({
    where: { id: input.threadId },
    select: {
      channel: {
        select: {
          agentBindings: {
            include: {
              agent: {
                select: { id: true, name: true, role: true, systemPrompt: true },
              },
            },
            orderBy: { createdAt: 'asc' },
          },
          members: {
            select: {
              user: { select: { id: true, displayName: true } },
            },
          },
          organizationId: true,
          systemChannelType: true,
        },
      },
    },
  })

  if (!thread) {
    return { kind: 'thread_not_found' }
  }

  // Resolve human + broadcast mentions on the inbound content. Agent mentions
  // are resolved below for engagement; here we record every mention class on
  // message.metadata.mentions so clients can highlight/notify deterministically.
  const mentions = resolveMessageMentions(input.content, {
    members: thread.channel.members.map((m) => ({
      userId: m.user.id,
      displayName: m.user.displayName,
    })),
  })

  const message = await prisma.message.create({
    data: {
      threadId: input.threadId,
      userId: input.userId,
      role: 'user',
      content: input.content,
      metadata: { mentions } as Prisma.InputJsonValue,
    },
    include: messageInclude,
  })

  const channelAgents: ChannelAgent[] = thread.channel.agentBindings.map((b) => ({
    id: b.agent.id,
    name: b.agent.name,
    role: b.agent.role,
    systemPrompt: b.agent.systemPrompt,
  }))
  const resolvedChannelAgents =
    thread.channel.systemChannelType === 'personal_assistant'
      ? channelAgents.slice(0, 1)
      : channelAgents

  // An @mention of an agent that is NOT a member (bound) of this channel does
  // not silently pull it in: only members participate. Such mentions are
  // surfaced as pending invites so the client can offer to add the agent to the
  // channel (after which it participates like any other member). Agent names can
  // contain spaces, so we match each candidate name against the content with the
  // same escape rule the orchestrator uses rather than splitting on whitespace.
  const pendingAgentInvites: { id: string; name: string }[] = []
  if (input.content.includes('@')) {
    const boundIds = new Set(resolvedChannelAgents.map((a) => a.id))
    const candidates = await prisma.agent.findMany({
      where: {
        agentKind: 'shared',
        id: { notIn: [...boundIds] },
        organizationId: thread.channel.organizationId,
        systemManaged: false,
      },
      select: { id: true, name: true },
    })

    for (const agent of candidates) {
      const escaped = agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const mentionRe = new RegExp(`@${escaped}(?:\\s|$|[^\\w])`, 'i')
      if (mentionRe.test(input.content)) {
        pendingAgentInvites.push({ id: agent.id, name: agent.name })
      }
    }
  }

  // Record which agents the message @mentioned (bound or freshly resolved).
  // Only persist a metadata update when there are agent mentions to add —
  // human/broadcast mentions were already written at create time.
  const mentionedAgentIds = mentionedAgentIdsFromContent(
    input.content,
    resolvedChannelAgents,
  )
  let persistedMessage = message
  if (mentionedAgentIds.length > 0) {
    const merged = { ...mentions, agentIds: mentionedAgentIds }
    persistedMessage = await prisma.message.update({
      where: { id: message.id },
      data: { metadata: { mentions: merged } as Prisma.InputJsonValue },
      include: messageInclude,
    })
  }

  return {
    kind: 'created',
    message: persistedMessage,
    channelAgents: resolvedChannelAgents,
    pendingAgentInvites,
  }
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

export const mapMessageRecord = (message: MessageWithReactions): ThreadMessageRecord =>
  mapThreadMessageRecord(message)

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

  // Predictive full-text query: each term gets a `:*` prefix match so a partial
  // word like "tick" finds "ticket". Sanitized down to bare word tokens so the
  // raw input can never inject tsquery operators.
  const prefixQuery = input.query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `${term}:*`)
    .join(' & ')
  if (!prefixQuery) {
    return []
  }

  const conditions: Prisma.Sql[] = [
    Prisma.sql`m."deleted_at" IS NULL`,
    Prisma.sql`t."channel_id" IN (${Prisma.join(
      channelIds.map((id) => Prisma.sql`${id}::uuid`),
    )})`,
    Prisma.sql`to_tsvector('english', m."content") @@ to_tsquery('english', ${prefixQuery})`,
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
