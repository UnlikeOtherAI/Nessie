import { Prisma, type PrismaClient } from '@prisma/client'
import { parseThreadId, type AgentMessagePage } from '@nessie/schemas'
import { isSystemManagedAgent } from '@nessie/team-admin'

import {
  filterReadableAgentMessages,
  type DisclosureAgentVisibilityScope,
} from './agent-read-disclosure.js'
import {
  AgentMessageCursorError,
  decodeAgentMessageCursor,
  encodeAgentMessageCursor,
} from './agent-message-cursor.js'

/** Maximum merged candidates one history request may inspect. */
export const AGENT_MESSAGE_HISTORY_CANDIDATE_LIMIT = 100

const messageInclude = {
  basisScopes: { select: { scopeId: true, scopeType: true } },
  disclosureSources: { select: { sourceAuthorUserId: true, sourceChannelId: true } },
  thread: { select: { channelId: true } },
} satisfies Prisma.MessageInclude

type MessageCandidate = Prisma.MessageGetPayload<{ include: typeof messageInclude }>

type AgentMessageHistoryInput = {
  cursor?: string
  cursorSecret: string
  direction?: 'backward' | 'forward'
  includeSystemManaged?: boolean
  limit: number
  visibility: DisclosureAgentVisibilityScope
}

type AgentMessageHistoryResult = {
  data: AgentMessagePage
  meta: { hasMore: boolean; nextCursor: string | null; prevCursor: string | null }
}

const emptyResult = (): AgentMessageHistoryResult => ({
  data: { items: [] },
  meta: { hasMore: false, nextCursor: null, prevCursor: null },
})

const compareCandidates = (
  direction: 'backward' | 'forward',
  left: MessageCandidate,
  right: MessageCandidate,
): number => {
  const byTime = left.createdAt.getTime() - right.createdAt.getTime()
  if (byTime !== 0) return direction === 'forward' ? -byTime : byTime
  return direction === 'forward'
    ? right.id.localeCompare(left.id)
    : left.id.localeCompare(right.id)
}

const mergeCandidates = (
  direction: 'backward' | 'forward',
  limit: number,
  ...batches: readonly MessageCandidate[][]
): MessageCandidate[] => {
  const byId = new Map<string, MessageCandidate>()
  for (const candidate of batches.flat()) byId.set(candidate.id, candidate)
  return [...byId.values()]
    .sort((left, right) => compareCandidates(direction, left, right))
    .slice(0, limit)
}

/**
 * Reads the agent's own posts and messages from its runs in two independently
 * indexed keyset arms. The direct arm reads at most 101 rows. The run-derived
 * arm uses indexed lateral top-k reads, at most 101 rows for each conversation
 * the agent ran in, then merges one 100-row candidate window for the shared
 * channel-and-disclosure predicate. Its work therefore grows with an agent's
 * distinct conversations, never the full message history of those threads.
 */
export const loadAgentMessages = async (
  prisma: PrismaClient,
  agentId: string,
  input: AgentMessageHistoryInput,
): Promise<AgentMessageHistoryResult> => {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { agentKind: true, systemManaged: true },
  })
  if (!agent) return emptyResult()
  if (!input.includeSystemManaged && isSystemManagedAgent(agent)) return emptyResult()

  const direction = input.direction === 'backward' && input.cursor ? 'backward' : 'forward'
  const cursor = input.cursor
    ? decodeAgentMessageCursor(input.cursor, {
      agentId,
      organizationId: input.visibility.organizationId,
      secret: input.cursorSecret,
      userId: input.visibility.userId,
    })
    : null
  if (input.cursor && !cursor) throw new AgentMessageCursorError()

  const cursorWhere: Prisma.MessageWhereInput | undefined = cursor
    ? direction === 'forward'
      ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        }
      : {
          OR: [
            { createdAt: { gt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { gt: cursor.id } },
          ],
        }
    : undefined
  const snapshotWhere: Prisma.MessageWhereInput | undefined = cursor?.snapshot
    ? {
        OR: [
          { createdAt: { lt: cursor.snapshot.createdAt } },
          { createdAt: cursor.snapshot.createdAt, id: { lte: cursor.snapshot.id } },
        ],
      }
    : undefined
  const directWhere: Prisma.MessageWhereInput = {
    agentId,
  }
  const scanLimit = Math.min(
    Math.max(input.limit * 4, input.limit),
    AGENT_MESSAGE_HISTORY_CANDIDATE_LIMIT,
  )
  const query = (where: Prisma.MessageWhereInput) => prisma.message.findMany({
    where: cursorWhere || snapshotWhere
      ? { AND: [where, ...(cursorWhere ? [cursorWhere] : []), ...(snapshotWhere ? [snapshotWhere] : [])] }
      : where,
    include: messageInclude,
    orderBy: direction === 'forward'
      ? [{ createdAt: 'desc' }, { id: 'desc' }]
      : [{ createdAt: 'asc' }, { id: 'asc' }],
    take: scanLimit + 1,
  })
  const keyset = cursor
    ? direction === 'forward'
      ? Prisma.sql`AND (m.created_at, m.id) < (${cursor.createdAt}, ${cursor.id}::uuid)`
      : Prisma.sql`AND (m.created_at, m.id) > (${cursor.createdAt}, ${cursor.id}::uuid)`
    : Prisma.empty
  const snapshotKeyset = cursor?.snapshot
    ? Prisma.sql`AND (m.created_at, m.id) <= (${cursor.snapshot.createdAt}, ${cursor.snapshot.id}::uuid)`
    : Prisma.empty
  const runDerivedQuery = direction === 'forward'
    ? Prisma.sql`
        WITH run_threads AS (
          SELECT DISTINCT r.thread_id
          FROM runs AS r
          WHERE r.agent_id = ${agentId}::uuid
        ), run_candidates AS (
          SELECT candidate.id, candidate.created_at
          FROM run_threads
          CROSS JOIN LATERAL (
            SELECT m.id, m.created_at
            FROM messages AS m
            WHERE m.thread_id = run_threads.thread_id ${keyset} ${snapshotKeyset}
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT ${scanLimit + 1}
          ) AS candidate
        )
        SELECT id
        FROM run_candidates
        ORDER BY created_at DESC, id DESC
        LIMIT ${scanLimit + 1}
      `
    : Prisma.sql`
        WITH run_threads AS (
          SELECT DISTINCT r.thread_id
          FROM runs AS r
          WHERE r.agent_id = ${agentId}::uuid
        ), run_candidates AS (
          SELECT candidate.id, candidate.created_at
          FROM run_threads
          CROSS JOIN LATERAL (
            SELECT m.id, m.created_at
            FROM messages AS m
            WHERE m.thread_id = run_threads.thread_id ${keyset} ${snapshotKeyset}
            ORDER BY m.created_at ASC, m.id ASC
            LIMIT ${scanLimit + 1}
          ) AS candidate
        )
        SELECT id
        FROM run_candidates
        ORDER BY created_at ASC, id ASC
        LIMIT ${scanLimit + 1}
      `
  const [directRows, runDerivedIds] = await Promise.all([
    query(directWhere),
    prisma.$queryRaw<Array<{ id: string }>>(runDerivedQuery),
  ])
  const runDerivedRows = runDerivedIds.length === 0
    ? []
    : await prisma.message.findMany({
      where: { id: { in: runDerivedIds.map((row) => row.id) } },
      include: messageInclude,
    })
  const rows = mergeCandidates(direction, scanLimit + 1, directRows, runDerivedRows)
  const candidates = rows.slice(0, scanLimit)
  const snapshot = cursor?.snapshot ?? candidates[0]
  const readable = await filterReadableAgentMessages(prisma, candidates, input.visibility)
  const selected = readable.slice(0, input.limit)
  const messages = direction === 'forward' ? selected : selected.slice().reverse()
  const lastReturned = messages.at(-1)
  const firstReturned = messages[0]
  const nextAnchor = lastReturned ?? (direction === 'forward' ? candidates.at(-1) : candidates[0])
  const prevAnchor = firstReturned ?? (direction === 'forward' ? candidates[0] : candidates.at(-1))
  const hasUnscannedCandidates = rows.length > scanLimit
  const hasCandidatesAfterSelected = selected.length > 0
    && selected.at(-1) !== candidates.at(-1)
  const nextCursor = nextAnchor
    && (direction === 'backward'
      ? Boolean(input.cursor)
      : hasUnscannedCandidates || hasCandidatesAfterSelected)
    ? encodeAgentMessageCursor({
      agentId,
      createdAt: nextAnchor.createdAt.toISOString(),
      id: nextAnchor.id,
      organizationId: input.visibility.organizationId,
      ...(snapshot
        ? { snapshotCreatedAt: snapshot.createdAt.toISOString(), snapshotId: snapshot.id }
        : {}),
      userId: input.visibility.userId,
    }, input.cursorSecret)
    : null
  const prevCursor = prevAnchor
    && (direction === 'backward'
      ? hasUnscannedCandidates || hasCandidatesAfterSelected
      : Boolean(input.cursor))
    ? encodeAgentMessageCursor({
      agentId,
      createdAt: prevAnchor.createdAt.toISOString(),
      id: prevAnchor.id,
      organizationId: input.visibility.organizationId,
      ...(snapshot
        ? { snapshotCreatedAt: snapshot.createdAt.toISOString(), snapshotId: snapshot.id }
        : {}),
      userId: input.visibility.userId,
    }, input.cursorSecret)
    : null

  return {
    data: {
      items: messages.map((message) => ({
        messageId: message.id,
        role: message.role,
        contentPreview: message.content.slice(0, 500),
        fullContent: message.content,
        threadId: parseThreadId(message.threadId),
        timestamp: message.createdAt.toISOString(),
      })),
    },
    meta: { hasMore: nextCursor !== null, nextCursor, prevCursor },
  }
}
