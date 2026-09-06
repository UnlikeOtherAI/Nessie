import type { PrismaClient } from '@prisma/client'
import { parseAgentId, parseRunId } from '@nessie/schemas'

import type { RunThinkingEntry, RunThinkingLog, ThreadThinking } from '../contracts/messaging.js'
import { canUserReadRunBasis } from './run-disclosure.js'

// The full log is capped so a very long run cannot return an unbounded payload;
// the bootstrap tail only needs enough to fill the bubble's ticker plus a bit of
// scrollback until the live stream takes over.
export const RUN_THINKING_LOG_LIMIT = 500
export const THREAD_THINKING_TAIL_LIMIT = 50
// Live runs on one thread are serialized per (agent, thread), so this bound is
// generous; it only guards against a pathological fan-out.
const THREAD_THINKING_RUN_LIMIT = 10

type ChunkRow = {
  id: bigint
  kind: 'reasoning' | 'tool'
  content: string
  createdAt: Date
}

// BigInt ids never survive JSON.stringify — always serialize as decimal strings
// (the same rule as `Attachment.sizeBytes`).
const toEntry = (row: ChunkRow): RunThinkingEntry => ({
  id: row.id.toString(),
  kind: row.kind,
  content: row.content,
  createdAt: row.createdAt.toISOString(),
})

// Newest-first read (the index is on (run_id, id)) flipped back into log order.
// Reading one extra row is what tells us whether a prefix was elided.
const loadTail = async (
  prisma: PrismaClient,
  runId: string,
  limit: number,
): Promise<{ entries: RunThinkingEntry[]; truncated: boolean }> => {
  const rows = await prisma.runThinkingChunk.findMany({
    where: { runId },
    orderBy: { id: 'desc' },
    take: limit + 1,
    select: { id: true, kind: true, content: true, createdAt: true },
  })
  return {
    entries: rows.slice(0, limit).reverse().map(toEntry),
    truncated: rows.length > limit,
  }
}

/**
 * The full thought log of one run, for the "show me everything it thought"
 * dialog. Returns null when the run does not belong to the thread the caller
 * was authorized against, so the route can answer 404 without leaking that the
 * run exists elsewhere.
 */
export const loadRunThinkingLog = async (
  prisma: PrismaClient,
  input: { runId: string; threadId: string },
): Promise<RunThinkingLog | null> => {
  const run = await prisma.run.findFirst({
    where: { id: input.runId, threadId: input.threadId },
    select: { id: true, agentId: true, status: true, replyRootMessageId: true },
  })
  if (!run) return null

  const { entries, truncated } = await loadTail(prisma, run.id, RUN_THINKING_LOG_LIMIT)
  return {
    run: {
      id: parseRunId(run.id),
      agentId: parseAgentId(run.agentId),
      status: run.status,
      rootMessageId: run.replyRootMessageId,
    },
    entries,
    truncated,
  }
}

/**
 * Bootstrap for a client that joined mid-run: the thread's live runs with their
 * resolved reply anchor and the tail of each thought log. `stream.*` events are
 * deliberately never replayed from the SSE backlog, so this is how a late
 * joiner (or a reconnecting client) recovers the bubble state.
 *
 * Only `running` runs are reported: a queued run has not published
 * `stream.start` yet and therefore has no bubble to show.
 */
export const loadThreadThinking = async (
  prisma: PrismaClient,
  threadId: string,
  // Who is reading. A run's reasoning inherits the provenance of the sources it
  // was built from, so a viewer who would be withheld the reply is withheld the
  // thinking too. The run stays listed — the bubble is the honest signal that
  // *something* is happening — but carries no entries.
  viewer: { organizationId: string; userId: string },
): Promise<ThreadThinking> => {
  const runs = await prisma.run.findMany({
    where: { threadId, status: 'running' },
    orderBy: { createdAt: 'asc' },
    take: THREAD_THINKING_RUN_LIMIT,
    select: { id: true, agentId: true, replyRootMessageId: true, startedAt: true },
  })

  const readable = await Promise.all(
    runs.map((run) =>
      canUserReadRunBasis(prisma, {
        organizationId: viewer.organizationId,
        runId: run.id,
        userId: viewer.userId,
      }),
    ),
  )

  const entries = await Promise.all(
    runs.map((run, index) =>
      readable[index]
        ? loadTail(prisma, run.id, THREAD_THINKING_TAIL_LIMIT)
        : Promise.resolve({ entries: [], truncated: false }),
    ),
  )

  return {
    runs: runs.map((run, index) => {
      const tail = entries[index]?.entries ?? []
      return {
        runId: parseRunId(run.id),
        agentId: parseAgentId(run.agentId),
        rootMessageId: run.replyRootMessageId,
        startedAt: run.startedAt?.toISOString() ?? null,
        entries: tail,
        lastChunkId: tail.at(-1)?.id ?? null,
      }
    }),
  }
}
