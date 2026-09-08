import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { buildVisibleAgentWhere } from '@nessie/db'
import {
  canUserReadRunBasis,
  resolveDisclosureViewer,
  viewerSatisfiesBasis,
  type BasisScopeRow,
} from '@nessie/runtime'
import {
  buildPage,
  CONVERSATION_PREVIEW_MAX_CHARS,
  CONVERSATION_PROGRESS_LINE_MAX_CHARS,
  CONVERSATION_TITLE_MAX_CHARS,
  decodeKeysetCursor,
  parseAgentId,
  parseChannelId,
  parseRunId,
  parseThreadId,
  parseUserId,
  resolvePageLimit,
  type ActiveRunStatus,
  type AgentConversationRecord,
  type PaginationMeta,
  type RunOutcome,
} from '@nessie/schemas'

import { buildAccessibleChannelWhere } from './agent-record.js'
import { canManageChannel } from './channel-manage.js'
import { loadLastMessageAtByThread, loadUnreadCountsByThread } from './channel-records.js'

/**
 * Conversations with an agent.
 *
 * A conversation **is** a `Thread` — see
 * docs/plans/2026-09-08-agent-conversations.md for why a second container beside
 * it was rejected. This module holds everything both doors (the API routes and
 * the assistant's tools) have to agree on: which threads a person may open,
 * which of them belong in an agent's list, how a title is derived, how one
 * conversation is projected onto the wire, and where a new one may start.
 *
 * Nothing here authors a message, claims a run, or creates a channel or a
 * binding. Those are separate doors with different authorship — a person's
 * send is `createThreadMessage`, the assistant's is `createAgentMessage` with a
 * computed disclosure basis — and folding them in here is exactly what would
 * make the two drift.
 */

/** A conversation whose thread has no title of its own and no room to borrow. */
export const DEFAULT_CONVERSATION_TITLE = 'New conversation'

/**
 * How many of a viewer's candidate threads one list read considers.
 *
 * The page is ordered by *activity*, which is `MAX(messages.created_at)` per
 * thread and therefore not a column any index can sort — the same reason the
 * Threads inbox (`listThreadActivity`) orders its candidate set in memory. The
 * cap keeps that honest: one agent's conversations visible to one person is a
 * list of tens, and a deployment that ever exceeds it wants a materialised
 * activity column, not a bigger fetch.
 */
export const AGENT_CONVERSATION_CANDIDATE_LIMIT = 1000

const ACTIVE_RUN_STATUSES = [
  'pending',
  'running',
  'waiting_approval',
  'waiting_input',
] as const satisfies readonly ActiveRunStatus[]

const TERMINAL_RUN_STATUSES = [
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly RunOutcome[]

/**
 * Which threads a person may open, as one predicate.
 *
 * This is exactly what `findThreadForUser`
 * (`api/src/services/message-read-state.ts`) has always applied — the room is
 * the audience and a thread inherits it — extracted so the read-state service,
 * an agent's conversation list, the start door and the `conversation_reference`
 * tool cannot drift apart. `findThreadForUser` is written on top of it.
 */
export const buildViewerThreadWhere = (
  userId: string,
  organizationId: string,
): Prisma.ThreadWhereInput => ({
  channel: buildAccessibleChannelWhere({ organizationId, userId }),
})

/**
 * The threads that belong in agent X's list for viewer V.
 *
 * Two arms, stated once here and nowhere else:
 * - the thread is a conversation *with* X (`agent_id = X`), or
 * - it is the General thread of a room X is bound to — which is what makes the
 *   rooms an agent works in appear as the conversations they are. The
 *   `principalUserId` clause keeps the Personal Assistant's shared-room
 *   presence for one person out of another person's list.
 */
export const buildAgentConversationWhere = (input: {
  agentId: string
  organizationId: string
  userId: string
}): Prisma.ThreadWhereInput => ({
  ...buildViewerThreadWhere(input.userId, input.organizationId),
  OR: [
    { agentId: input.agentId },
    {
      agentId: null,
      channel: {
        agentBindings: {
          some: {
            agentId: input.agentId,
            OR: [{ principalUserId: null }, { principalUserId: input.userId }],
          },
        },
      },
    },
  ],
})

const truncateTitle = (value: string): string =>
  value.length <= CONVERSATION_TITLE_MAX_CHARS
    ? value
    : `${value.slice(0, CONVERSATION_TITLE_MAX_CHARS - 1).trimEnd()}…`

/**
 * The title a new conversation carries.
 *
 * Text, not intent: the caller's title, else the first non-empty line of the
 * opening message with its whitespace collapsed, else a plain default. No model
 * call — a derived title that took an inference would make opening a
 * conversation cost one, and the person can rename it in a keystroke.
 *
 * It lives here rather than at either door so the person's "New conversation"
 * button and the assistant's `agent_conversation_start` name things the same
 * way.
 */
export const deriveConversationTitle = (input: {
  message?: string | null | undefined
  title?: string | null | undefined
}): string => {
  const given = input.title?.trim()
  if (given) return truncateTitle(given)

  const firstLine = (input.message ?? '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find((line) => line.length > 0)
  if (firstLine) return truncateTitle(firstLine)

  return DEFAULT_CONVERSATION_TITLE
}

const conversationThreadSelect = {
  id: true,
  agentId: true,
  title: true,
  startedByUserId: true,
  createdAt: true,
  channel: {
    select: {
      id: true,
      label: true,
      type: true,
      systemChannelType: true,
      team: { select: { project: { select: { channelRoot: true, name: true } } } },
      agentBindings: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { agentId: true, principalUserId: true },
      },
    },
  },
} satisfies Prisma.ThreadSelect

type ConversationThreadRow = Prisma.ThreadGetPayload<{ select: typeof conversationThreadSelect }>

/**
 * The newest thought-log line of a running run, or nothing.
 *
 * The *gate* is the thinking bubble's own — `canUserReadRunBasis`, the function
 * `loadThreadThinking` uses — because a viewer withheld a run's reply must be
 * withheld what it is thinking, here as there. Only the read differs: the
 * bubble wants a tail to scroll, a conversation row wants one line.
 */
export const loadRunProgressLine = async (
  prisma: PrismaClient,
  input: { organizationId: string; runId: string; userId: string },
): Promise<string | null> => {
  if (!(await canUserReadRunBasis(prisma, input))) return null

  const chunk = await prisma.runThinkingChunk.findFirst({
    where: { runId: input.runId },
    orderBy: { id: 'desc' },
    select: { content: true },
  })
  if (!chunk) return null

  const line = chunk.content.replace(/\s+/g, ' ').trim()
  return line ? line.slice(0, CONVERSATION_PROGRESS_LINE_MAX_CHARS) : null
}

/**
 * The agent a General thread is listed under.
 *
 * A conversation names its agent; a General row borrows one from the room's
 * bindings, oldest first so the answer is the same on every read. A presence
 * binding placed by somebody else is not this viewer's.
 */
const resolveGeneralThreadAgentId = (
  row: ConversationThreadRow,
  userId: string,
): string | null =>
  row.channel.agentBindings.find(
    (binding) => binding.principalUserId === null || binding.principalUserId === userId,
  )?.agentId ?? null

const uuidList = (ids: string[]): Prisma.Sql =>
  Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))

type PreviewRow = { thread_id: string; id: string; content: string }

/**
 * The newest message a viewer may read, at most
 * `CONVERSATION_PREVIEW_MAX_CHARS` of it.
 *
 * The predicate is the one every other message read applies —
 * `resolveDisclosureViewer` + `viewerSatisfiesBasis` (`@nessie/runtime`), what
 * `listThreadMessages` withholds a feed row with and what `canUserReadRunBasis`
 * asks on the run side for `progressLine`. Fail closed on an **unsatisfied**
 * basis, not on the existence of one: the previous rule (any
 * `message_basis_scopes` row at all) hid a reply from the very person who asked
 * for it, because an assistant-started conversation's reply carries the
 * requester's own DM as its lineage.
 *
 * A withheld newest message contributes null rather than an older readable
 * line: reaching past it would tell the list that something newer exists.
 * Grants are deliberately not consulted here — a preview is a quotation in a
 * list, with none of the "readable, but not yours to pass on" framing the
 * conversation itself carries, so a grant-only read stays inside the thread.
 *
 * Two queries, whatever the page size: `DISTINCT ON` for the newest row per
 * thread, then the basis rows for exactly those ids. A page carrying no basis
 * at all resolves no viewer and costs nothing further.
 */
const loadLastMessagePreviews = async (
  prisma: PrismaClient,
  input: { organizationId: string; threadIds: string[]; userId: string },
): Promise<Map<string, string>> => {
  const previews = new Map<string, string>()
  if (input.threadIds.length === 0) return previews

  const rows = await prisma.$queryRaw<PreviewRow[]>(Prisma.sql`
    SELECT DISTINCT ON (m.thread_id)
      m.thread_id AS thread_id,
      m.id AS id,
      m.content AS content
    FROM "messages" m
    WHERE m.thread_id IN (${uuidList(input.threadIds)})
      AND m.deleted_at IS NULL
      AND m.role::text <> 'system'
    ORDER BY m.thread_id, m.created_at DESC, m.id DESC
  `)
  if (rows.length === 0) return previews

  const basisRows = await prisma.messageBasisScope.findMany({
    where: { messageId: { in: rows.map((row) => row.id) } },
    select: { messageId: true, scopeId: true, scopeType: true },
  })
  const basisByMessage = new Map<string, BasisScopeRow[]>()
  for (const row of basisRows) {
    const basis = basisByMessage.get(row.messageId) ?? []
    basis.push({ scopeId: row.scopeId, scopeType: row.scopeType })
    basisByMessage.set(row.messageId, basis)
  }
  // Resolved once for the whole page, never once per row.
  const viewer = basisRows.length > 0
    ? await resolveDisclosureViewer(prisma, input.organizationId, input.userId)
    : null

  for (const row of rows) {
    const basis = basisByMessage.get(row.id)
    if (basis && !(viewer && viewerSatisfiesBasis(basis, viewer))) continue
    // One line, always: a row and a card each give this a single line, and a
    // preview that carried the message's own newlines would either be clipped
    // by CSS or push the row's height around.
    const preview = row.content.replace(/\s+/g, ' ').trim()
    if (preview) previews.set(row.thread_id, preview.slice(0, CONVERSATION_PREVIEW_MAX_CHARS))
  }
  return previews
}

type ActiveRunRow = {
  thread_id: string
  id: string
  status: ActiveRunStatus
  started_at: Date | null
}

const loadActiveRuns = async (
  prisma: PrismaClient,
  input: { organizationId: string; threadIds: string[]; userId: string },
): Promise<Map<string, NonNullable<AgentConversationRecord['activeRun']>>> => {
  const active = new Map<string, NonNullable<AgentConversationRecord['activeRun']>>()
  if (input.threadIds.length === 0) return active

  const rows = await prisma.$queryRaw<ActiveRunRow[]>(Prisma.sql`
    SELECT DISTINCT ON (r.thread_id)
      r.thread_id AS thread_id,
      r.id AS id,
      r.status AS status,
      r.started_at AS started_at
    FROM "runs" r
    WHERE r.thread_id IN (${uuidList(input.threadIds)})
      AND r.status::text IN (${Prisma.join(ACTIVE_RUN_STATUSES.map((status) => Prisma.sql`${status}`))})
    ORDER BY r.thread_id, r.created_at DESC, r.id DESC
  `)

  for (const row of rows) {
    active.set(row.thread_id, {
      id: parseRunId(row.id),
      status: row.status,
      startedAt: row.started_at?.toISOString() ?? null,
      // Only a *running* run is doing something now; a queued one has written
      // nothing and a waiting one is waiting on a person, not on itself.
      progressLine:
        row.status === 'running'
          ? await loadRunProgressLine(prisma, {
            organizationId: input.organizationId,
            runId: row.id,
            userId: input.userId,
          })
          : null,
    })
  }
  return active
}

type OutcomeRow = { thread_id: string; status: RunOutcome }

const loadLastRunOutcomes = async (
  prisma: PrismaClient,
  threadIds: string[],
): Promise<Map<string, RunOutcome>> => {
  const outcomes = new Map<string, RunOutcome>()
  if (threadIds.length === 0) return outcomes

  const rows = await prisma.$queryRaw<OutcomeRow[]>(Prisma.sql`
    SELECT DISTINCT ON (r.thread_id)
      r.thread_id AS thread_id,
      r.status AS status
    FROM "runs" r
    WHERE r.thread_id IN (${uuidList(threadIds)})
      AND r.status::text IN (${Prisma.join(TERMINAL_RUN_STATUSES.map((status) => Prisma.sql`${status}`))})
    ORDER BY r.thread_id, r.finished_at DESC NULLS LAST, r.created_at DESC, r.id DESC
  `)

  for (const row of rows) outcomes.set(row.thread_id, row.status)
  return outcomes
}

/**
 * One projection for the list and for the single read, so a card and the row
 * that opened it can never disagree about what a conversation is.
 */
const buildConversationRecords = async (
  prisma: PrismaClient,
  input: {
    /** Precomputed by the list, which already needed it to order the page. */
    lastActivityByThread?: Map<string, string>
    organizationId: string
    rows: ConversationThreadRow[]
    userId: string
  },
): Promise<AgentConversationRecord[]> => {
  const threadIds = input.rows.map((row) => row.id)
  const [lastActivity, unread, previews, activeRuns, outcomes] = await Promise.all([
    input.lastActivityByThread
      ? Promise.resolve(input.lastActivityByThread)
      : loadLastMessageAtByThread(prisma, threadIds),
    loadUnreadCountsByThread(prisma, threadIds, input.userId),
    loadLastMessagePreviews(prisma, {
      organizationId: input.organizationId,
      threadIds,
      userId: input.userId,
    }),
    loadActiveRuns(prisma, {
      organizationId: input.organizationId,
      threadIds,
      userId: input.userId,
    }),
    loadLastRunOutcomes(prisma, threadIds),
  ])

  const records: AgentConversationRecord[] = []
  for (const row of input.rows) {
    const isGeneral = row.agentId === null
    const agentId = row.agentId ?? resolveGeneralThreadAgentId(row, input.userId)
    // A General thread of a room with no agent this viewer can see is not a
    // conversation with anybody. It is absent rather than rendered agentless.
    if (!agentId) continue

    const project = row.channel.team.project
    records.push({
      id: parseThreadId(row.id),
      agentId: parseAgentId(agentId),
      // Never empty: a General row is named by its room, and a conversation
      // opened with neither a title nor an opening line falls back in words.
      title: isGeneral
        ? row.channel.label
        : row.title?.trim() || DEFAULT_CONVERSATION_TITLE,
      isGeneral,
      channel: {
        id: parseChannelId(row.channel.id),
        label: row.channel.label,
        type: row.channel.type,
        systemChannelType: row.channel.systemChannelType ?? null,
        projectName: row.channel.type === 'dm' || project.channelRoot ? null : project.name,
      },
      startedByUserId: row.startedByUserId ? parseUserId(row.startedByUserId) : null,
      lastActivityAt: lastActivity.get(row.id) ?? null,
      lastMessagePreview: previews.get(row.id) ?? null,
      unreadCount: unread.get(row.id) ?? 0,
      activeRun: activeRuns.get(row.id) ?? null,
      lastRunOutcome: outcomes.get(row.id) ?? null,
      createdAt: row.createdAt.toISOString(),
    })
  }
  return records
}

/**
 * One conversation, by thread — the read behind a live card and a deep link.
 *
 * `null` means "not visible", in the same words `findThreadForUser` uses, so a
 * thread id confirms nothing. A General thread of a channel with no agent the
 * viewer can see is null too: that is a room, not a conversation with anyone.
 */
export const loadConversationForUser = async (
  prisma: PrismaClient,
  input: { organizationId: string; threadId: string; userId: string },
): Promise<AgentConversationRecord | null> => {
  const row = await prisma.thread.findFirst({
    where: {
      id: input.threadId,
      ...buildViewerThreadWhere(input.userId, input.organizationId),
    },
    select: conversationThreadSelect,
  })
  if (!row) return null

  const [record] = await buildConversationRecords(prisma, {
    organizationId: input.organizationId,
    rows: [row],
    userId: input.userId,
  })
  return record ?? null
}

/**
 * An agent's conversations, as this person may see them.
 *
 * `null` — not an empty page — when the viewer can see nothing of this agent at
 * all, so the route answers 404 and an id never confirms an agent exists. (The
 * design doc writes the return as `{ data, meta }`; the nullable outcome is
 * what lets "zero rows plus an invisible agent is a 404" live here instead of
 * being restated at every door.)
 */
export const listAgentConversationsForUser = async (
  prisma: PrismaClient,
  input: {
    agentId: string
    cursor?: string | undefined
    limit?: number | undefined
    organizationId: string
    userId: string
  },
): Promise<{ data: AgentConversationRecord[]; meta: PaginationMeta } | null> => {
  // Deliberately NOT `isAgentAccessibleToActor`: that refuses every
  // system-managed agent, which would 404 the Personal Assistant in its own DM.
  // `organizationId: null` is the app-provided global tier, which belongs to no
  // tenant. Written as an OR rather than `{ in: [tenant, null] }` because SQL's
  // `IN` never matches NULL.
  const agent = await prisma.agent.findFirst({
    where: {
      id: input.agentId,
      OR: [{ organizationId: input.organizationId }, { organizationId: null }],
    },
    select: { id: true },
  })
  if (!agent) return null

  const candidates = await prisma.thread.findMany({
    where: buildAgentConversationWhere(input),
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: AGENT_CONVERSATION_CANDIDATE_LIMIT,
    select: conversationThreadSelect,
  })

  if (candidates.length === 0) {
    const visible = await prisma.agent.count({
      where: {
        id: input.agentId,
        AND: [buildVisibleAgentWhere(input)],
      },
    })
    if (visible === 0) return null
  }

  const lastActivityByThread = await loadLastMessageAtByThread(
    prisma,
    candidates.map((row) => row.id),
  )
  // An empty conversation sorts by its own creation, so the row the "New
  // conversation" button just made is at the top of the list it came from
  // rather than at the bottom. The record still reports `lastActivityAt: null`.
  const sortKeyOf = (row: ConversationThreadRow): number =>
    new Date(lastActivityByThread.get(row.id) ?? row.createdAt.toISOString()).getTime()

  const ordered = [...candidates].sort(
    (left, right) => sortKeyOf(right) - sortKeyOf(left) || right.id.localeCompare(left.id),
  )

  const cursor = decodeKeysetCursor(input.cursor)
  const afterCursor = cursor
    ? ordered.filter((row) => {
      const key = sortKeyOf(row)
      const boundary = cursor.createdAt.getTime()
      return key < boundary || (key === boundary && row.id.localeCompare(cursor.id) < 0)
    })
    : ordered

  const limit = resolvePageLimit(input.limit)
  // `buildPage` cursors on `(createdAt, id)`; here that key is the activity
  // instant the page is ordered by, which is what a client must resume from.
  const page = buildPage({
    hasCursor: Boolean(cursor),
    limit,
    rows: afterCursor
      .slice(0, limit + 1)
      .map((row) => ({ id: row.id, createdAt: new Date(sortKeyOf(row)) })),
  })

  const rowsById = new Map(candidates.map((row) => [row.id, row]))
  return {
    data: await buildConversationRecords(prisma, {
      lastActivityByThread,
      organizationId: input.organizationId,
      rows: page.data.flatMap((row) => {
        const original = rowsById.get(row.id)
        return original ? [original] : []
      }),
      userId: input.userId,
    }),
    meta: page.meta,
  }
}

export type StartAgentConversationOutcome =
  | { kind: 'created'; thread: { id: string; channelId: string; title: string } }
  | { kind: 'agent_not_found' }
  /** No channel the caller may post in has this agent. An answer, not a fallback. */
  | { kind: 'no_room' }
  /** The named channel: not visible, archived, or the agent is not bound to it. */
  | { kind: 'channel_not_allowed' }

/** A room the caller can see, can still post in, and that this agent works in. */
const roomWhere = (input: {
  agentId: string
  organizationId: string
  userId: string
}): Prisma.ChannelWhereInput => ({
  ...buildAccessibleChannelWhere({
    organizationId: input.organizationId,
    userId: input.userId,
  }),
  archivedAt: null,
  // A system channel is admitted only for its own agent, which this clause
  // already says: `bindAgentToChannel` refuses every system channel, so the
  // only agent bound to one is the agent it was provisioned for.
  agentBindings: {
    some: {
      agentId: input.agentId,
      OR: [{ principalUserId: null }, { principalUserId: input.userId }],
    },
  },
})

const resolveNamedRoom = async (
  prisma: PrismaClient,
  input: {
    agentId: string
    channelId: string
    organizationId: string
    startedByUserId: string
  },
): Promise<string | null> => {
  const channel = await prisma.channel.findFirst({
    where: {
      id: input.channelId,
      ...roomWhere({
        agentId: input.agentId,
        organizationId: input.organizationId,
        userId: input.startedByUserId,
      }),
    },
    select: { id: true },
  })
  return channel?.id ?? null
}

/**
 * Where a conversation goes when the caller named no room, in order: their own
 * DM with this agent, else the room they may post in that has been active most
 * recently.
 */
const resolveDefaultRoom = async (
  prisma: PrismaClient,
  input: { agentId: string; organizationId: string; startedByUserId: string },
): Promise<string | null> => {
  const where = roomWhere({
    agentId: input.agentId,
    organizationId: input.organizationId,
    userId: input.startedByUserId,
  })

  // The caller's own DM with this agent, whatever `dmKey` shape provisioned it
  // (`pa:`, `gagent:`, `agent:`, `extagent:`, the shared-agent key). Keying on
  // the *bindings* rather than on the key's spelling keeps this one rule
  // instead of five: a DM the caller belongs to whose only bound agent is this
  // one is the conversation they already have.
  const dm = await prisma.channel.findFirst({
    where: {
      AND: [
        where,
        { agentBindings: { every: { agentId: input.agentId } } },
      ],
      type: 'dm',
      members: { some: { userId: input.startedByUserId } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  })
  if (dm) return dm.id

  const candidates = await prisma.channel.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: AGENT_CONVERSATION_CANDIDATE_LIMIT,
    select: { id: true, threads: { select: { id: true } } },
  })
  if (candidates.length === 0) return null

  const lastActivity = await loadLastMessageAtByThread(
    prisma,
    candidates.flatMap((channel) => channel.threads.map((thread) => thread.id)),
  )
  // ISO-8601 strings compare lexicographically in instant order, which is why
  // `loadLastMessageAtByThread` can hand them straight to a sort.
  const scored = candidates.map((channel) => ({
    id: channel.id,
    at: channel.threads.reduce<string>((newest, thread) => {
      const at = lastActivity.get(thread.id) ?? ''
      return at > newest ? at : newest
    }, ''),
  }))
  scored.sort((left, right) => right.at.localeCompare(left.at))
  return scored[0]?.id ?? null
}

/**
 * Open a conversation with an agent.
 *
 * Writes the `Thread` and nothing else — no message, no run, no channel, no
 * binding. `no_room` is the honest answer to "this agent is nowhere you can
 * talk to it"; creating a room to make the call succeed would be placement,
 * which is owner-gated and is a different decision entirely.
 */
export const startAgentConversation = async (
  prisma: PrismaClient,
  input: {
    agentId: string
    channelId?: string | undefined
    /**
     * Used only to derive a title when none was given; never written as a
     * message. The design doc leaves it off this signature, but the title rule
     * lives here and both doors would otherwise re-implement it.
     */
    message?: string | undefined
    organizationId: string
    startedByUserId: string
    title?: string | undefined
  },
): Promise<StartAgentConversationOutcome> => {
  const agent = await prisma.agent.findFirst({
    where: {
      id: input.agentId,
      OR: [{ organizationId: input.organizationId }, { organizationId: null }],
    },
    select: { id: true },
  })
  if (!agent) return { kind: 'agent_not_found' }

  const channelId = input.channelId
    ? await resolveNamedRoom(prisma, { ...input, channelId: input.channelId })
    : await resolveDefaultRoom(prisma, input)
  if (!channelId) {
    return input.channelId ? { kind: 'channel_not_allowed' } : { kind: 'no_room' }
  }

  const title = deriveConversationTitle({ message: input.message, title: input.title })
  const thread = await prisma.thread.create({
    data: {
      agentId: input.agentId,
      channelId,
      startedByUserId: input.startedByUserId,
      title,
    },
    select: { id: true, channelId: true },
  })
  return { kind: 'created', thread: { ...thread, title } }
}

export type RenameThreadOutcome =
  | { kind: 'renamed'; threadId: string }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  /** The room's own thread carries the room's name; there is nothing to rename. */
  | { kind: 'title_fixed' }

/**
 * Rename a conversation.
 *
 * Whoever started it, or anyone who can manage the room it lives in. A General
 * thread is refused in words rather than silently ignored: its name is the
 * channel's, and renaming a channel is a different door with a different
 * authority (`updateChannel`).
 */
export const renameThreadForUser = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    threadId: string
    title: string
    userId: string
  },
): Promise<RenameThreadOutcome> => {
  const thread = await prisma.thread.findFirst({
    where: {
      id: input.threadId,
      ...buildViewerThreadWhere(input.userId, input.organizationId),
    },
    select: { id: true, agentId: true, channelId: true, startedByUserId: true },
  })
  if (!thread) return { kind: 'not_found' }
  if (thread.agentId === null) return { kind: 'title_fixed' }

  if (thread.startedByUserId !== input.userId) {
    const manage = await canManageChannel(prisma, {
      channelId: thread.channelId,
      organizationId: input.organizationId,
      userId: input.userId,
    })
    if (!manage) return { kind: 'forbidden' }
  }

  await prisma.thread.update({
    where: { id: thread.id },
    data: { title: truncateTitle(input.title.trim()) },
  })
  return { kind: 'renamed', threadId: thread.id }
}
