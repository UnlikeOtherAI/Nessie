import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import {
  canUserReadDisclosureBasis,
  partitionByDisclosure,
  resolveDisclosureViewer,
  resolveGrantedScopeKeysForMessages,
  viewerSatisfiesBasis,
} from '@nessie/runtime'
import { parseAgentId, parseThreadId, parseUserId } from '@nessie/schemas'
import { messageInclude, type MessageWithReactions } from '@nessie/team-admin'

import type { ThreadMessageRecord } from '../contracts/messaging.js'

/**
 * How a message row is loaded, shaped and paged for a reader.
 *
 * This is the bottom of the messaging stack: the Prisma `include` every writer
 * and reader shares, the row → wire mapper, and the thread feed. It owns no
 * mutation and no read cursor, so `message-create.ts` can depend on it without
 * the two files importing each other — the cycle that used to exist while the
 * shared shape lived in a module that also wrote.
 *
 * The `include` itself now lives in `@nessie/team-admin`, because the worker
 * authors messages too (the DeepSignal digest); it is re-exported here so this
 * module stays the one place the API asks for the shared shape.
 */

export { messageInclude }
export type { MessageWithReactions }

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
  onBehalfOfUserId: message.onBehalfOfUserId ?? undefined,
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
    onBehalfOfUserId: r.onBehalfOfUserId ?? undefined,
    userId: r.userId ? parseUserId(r.userId) : undefined,
    emoji: r.emoji,
    createdAt: r.createdAt.toISOString(),
  })),
})

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
  const messageViewer = await resolveDisclosureViewer(
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
    hasMore: boolean
    nextCursor: string | null
    // Chat history only walks backwards (into older messages), so there is no
    // forward cursor — always null, kept only to satisfy the one envelope.
    prevCursor: null
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
    ? await resolveDisclosureViewer(prisma, options.organizationId, options.viewerUserId)
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
  // One batched resolution for the whole page. Resolving grants row by row cost
  // two round trips per withheld row, in series, on the product's most-executed
  // read; the page-wide form is a fixed two queries plus one per distinct
  // granter.
  const grantsByMessage = options.organizationId && viewer.kind === 'user' && grantChannelId
    ? await resolveGrantedScopeKeysForMessages(prisma, {
      channelId: grantChannelId,
      messages: provisional.withheld.map((row) => ({
        agentId: row.agentId,
        basis: row.basisScopes,
        messageId: row.id,
      })),
      organizationId: options.organizationId,
      viewerChannelIds: viewer.scopes
        .filter((scope) => scope.scopeType === 'channel')
        .map((scope) => scope.scopeId),
      viewerUserId: viewer.userId,
    })
    : new Map<string, Set<string>>()
  const withheldIds = new Set<string>()
  // Everything the predicate admitted without consulting grants is read on the
  // caller's own entitlement, so it stays shareable.
  const grantOnlyIds = new Set<string>()
  for (const row of provisional.withheld) {
    const granted = grantsByMessage.get(row.id) ?? new Set<string>()
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
      hasMore,
      nextCursor: hasMore && oldest ? `${oldest.createdAt.toISOString()}|${oldest.id}` : null,
      // Chat history only walks backwards (into older messages), so there is no
      // forward cursor.
      prevCursor: null,
    },
  }
}
