// Agent thought process (thinking bubbles): shared wire/state types plus the
// pure merge, dedupe and tail-extraction helpers used by the thread stream hook
// and the channel feed. Deliberately React-free so it is unit-testable.

import type { ToolCallAttachment } from '@nessie/schemas'

export type ThinkingEntryKind = 'reasoning' | 'tool'

// One coalesced flush of an agent's thought process. `id` is the durable
// `run_thinking_chunks` id (a stringified BigInt); it is absent only for an
// event published without one.
export type ThinkingEntry = {
  // A tool line's screenshots: only the full log (`RunThinkingLog`) carries
  // them, since a live line is published before its call has returned anything.
  attachments?: ToolCallAttachment[]
  content: string
  id?: string
  kind: ThinkingEntryKind
}

// A run streaming into the open thread: its visible reply text so far plus its
// thought process, anchored where the reply will land (`rootMessageId` null =
// top level in the channel).
export type PendingStreamMessage = {
  agentId: string
  content: string
  rootMessageId: string | null
  runId: string
  // Seeded from the REST bootstrap because the viewer joined mid-run, so an
  // unknown prefix is missing locally and the dialog must fetch the full log.
  seededFromBootstrap?: boolean
  thinking: ThinkingEntry[]
}

type ThinkingLogEntry = {
  attachments?: ToolCallAttachment[]
  content: string
  createdAt: string
  id: string
  kind: ThinkingEntryKind
}

// GET /api/threads/:threadId/thinking — the live runs of a thread with a tail
// of their thought process, for a client that missed the (never replayed) SSE.
export type ThreadThinkingRun = {
  agentId: string
  entries: ThinkingLogEntry[]
  lastChunkId: string | null
  rootMessageId: string | null
  runId: string
  startedAt: string | null
}

export type ThreadThinking = {
  runs: ThreadThinkingRun[]
}

// GET /api/threads/:threadId/runs/:runId/thinking — one run's full log.
export type RunThinkingLog = {
  entries: ThinkingLogEntry[]
  run: {
    agentId: string
    id: string
    rootMessageId: string | null
    status: string
  }
  truncated: boolean
}

// A coalesced unit of thought: consecutive reasoning flushes read as one
// passage, each tool call as its own line.
export type ThinkingBlock = {
  attachments?: ToolCallAttachment[]
  key: string
  kind: ThinkingEntryKind
  text: string
}

const DIGITS = /^\d+$/

// Chunk ids are decimal BigInt strings; compare them numerically without
// parsing (length first, then lexicographically) and fall back to plain string
// order for anything unexpected.
export const compareChunkIds = (left: string, right: string): number => {
  if (DIGITS.test(left) && DIGITS.test(right) && left.length !== right.length) {
    return left.length - right.length
  }
  if (left === right) {
    return 0
  }
  return left < right ? -1 : 1
}

export const toThinkingEntries = (entries: ThinkingLogEntry[] | undefined): ThinkingEntry[] =>
  (entries ?? []).map((entry) => ({
    ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
    content: entry.content,
    id: entry.id,
    kind: entry.kind,
  }))

// Append a live chunk, ignoring one already present (a bootstrap fetch and the
// SSE stream overlap by design). A tool line the worker rewrites in place — a
// coding-session wait keeping its one line current — arrives again under the
// same id with new content, and replaces its entry where it stands. Returns
// the same array when nothing changed.
export const appendThinkingEntry = (
  entries: ThinkingEntry[],
  entry: ThinkingEntry,
): ThinkingEntry[] => {
  const at = entry.id ? entries.findIndex((existing) => existing.id === entry.id) : -1
  if (at < 0) return [...entries, entry]
  const existing = entries[at]!
  if (existing.kind !== 'tool' || entry.kind !== 'tool' || existing.content === entry.content) return entries
  return entries.map((current, index) => (index === at ? { ...current, content: entry.content } : current))
}

/**
 * Merge two views of one run's thought process. `base` is the view whose order
 * is trusted (the locally accumulated log); `incoming` contributes only chunks
 * `base` does not already have. Once every chunk carries an id the merged log
 * is restored to durable chunk order, so a fetched history window and live
 * events cannot interleave wrongly. A chunk both views hold keeps `base`'s
 * place but takes screenshots only `incoming` has: a live tool line never
 * carries them, the full log read once its call returned does.
 */
export const mergeThinkingEntries = (
  base: ThinkingEntry[],
  incoming: ThinkingEntry[],
): ThinkingEntry[] => {
  const seen = new Set(
    base.map((entry) => entry.id).filter((id): id is string => Boolean(id)),
  )
  const screenshots = new Map(
    incoming.flatMap((entry) => (entry.id && entry.attachments ? [[entry.id, entry.attachments] as const] : [])),
  )
  const merged = base.map((entry) => {
    const attachments = entry.id && !entry.attachments ? screenshots.get(entry.id) : undefined
    return attachments ? { ...entry, attachments } : entry
  })

  for (const entry of incoming) {
    if (entry.id) {
      if (seen.has(entry.id)) {
        continue
      }
      seen.add(entry.id)
    }
    merged.push(entry)
  }

  return merged.every((entry) => entry.id)
    ? [...merged].sort((left, right) => compareChunkIds(left.id ?? '', right.id ?? ''))
    : merged
}

// Consecutive reasoning flushes are one passage: the recorder splits on size and
// time, never on sentence boundaries, so re-joining them is what makes the text
// readable.
export const toThinkingBlocks = (entries: ThinkingEntry[]): ThinkingBlock[] => {
  const blocks: ThinkingBlock[] = []
  let buffer = ''
  let bufferKey: string | null = null

  const flushReasoning = () => {
    const text = buffer.trim()
    if (text && bufferKey) {
      blocks.push({ key: bufferKey, kind: 'reasoning', text })
    }
    buffer = ''
    bufferKey = null
  }

  entries.forEach((entry, index) => {
    const key = entry.id ?? `index-${index}`
    if (entry.kind === 'reasoning') {
      bufferKey = bufferKey ?? `reasoning-${key}`
      buffer += entry.content
      return
    }

    flushReasoning()
    const text = entry.content.trim()
    if (text) {
      blocks.push({
        ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
        key: `tool-${key}`,
        kind: 'tool',
        text,
      })
    }
  })
  flushReasoning()

  return blocks
}

/**
 * How many of a run's tool lines have something recorded after them, or all
 * of them once the run is no longer streaming. A call's line is written as it
 * starts; whatever follows the last line of a batch — the next reasoning, the
 * next batch's first line — is written only after every call in it returned,
 * and a local program's screenshots are kept before its call returns. So the
 * thought-process dialog reads the full log again whenever this grows —
 * sometimes early, beside a call of the same batch still running, but never
 * too late.
 */
export const countSettledToolLines = (blocks: ThinkingBlock[], streaming: boolean): number =>
  blocks.filter((block, index) => block.kind === 'tool' && (!streaming || index < blocks.length - 1)).length

// The bubble's ticker is lossy on purpose: only the tail of the thought process
// is kept in the DOM, and the viewport clips whatever no longer fits.
export const toThinkingLines = (
  entries: ThinkingEntry[],
  maxLines = 8,
): ThinkingBlock[] => {
  const lines: ThinkingBlock[] = []

  for (const block of toThinkingBlocks(entries)) {
    if (block.kind === 'tool') {
      lines.push(block)
      continue
    }
    block.text.split(/\r?\n/).forEach((rawLine, index) => {
      const text = rawLine.trim()
      if (text) {
        lines.push({ key: `${block.key}-${index}`, kind: 'reasoning', text })
      }
    })
  }

  return maxLines > 0 ? lines.slice(-maxLines) : lines
}

/**
 * Reconcile local pending runs with the REST bootstrap, which is the authority
 * on what is still running:
 *
 * - a run both sides know keeps its local order and gains any chunk the
 *   bootstrap has and the client missed;
 * - a run only the bootstrap reports is seeded (the viewer joined mid-run);
 * - a run only the client holds is a zombie and is dropped — unless its
 *   `stream.start` landed after the bootstrap request was sent, in which case
 *   the response is simply older than the run;
 * - a run this session already saw `stream.done` for is never re-seeded, even
 *   when the bootstrap response still lists it: the response was captured
 *   while the run was live and lost the race with its completion. Run ids are
 *   never reused (a restart mints a new run), so "finished" is final.
 */
export const reconcileThreadThinking = (
  current: PendingStreamMessage[],
  runs: ThreadThinkingRun[],
  protectedRunIds: ReadonlySet<string> = new Set<string>(),
  finishedRunIds: ReadonlySet<string> = new Set<string>(),
): PendingStreamMessage[] => {
  const liveRuns = runs.filter((run) => !finishedRunIds.has(run.runId))
  const unmatched = new Map(liveRuns.map((run) => [run.runId, run]))
  const reconciled: PendingStreamMessage[] = []

  for (const pending of current) {
    const bootstrap = unmatched.get(pending.runId)
    if (!bootstrap) {
      if (protectedRunIds.has(pending.runId)) {
        reconciled.push(pending)
      }
      continue
    }

    unmatched.delete(pending.runId)
    reconciled.push({
      ...pending,
      thinking: mergeThinkingEntries(pending.thinking, toThinkingEntries(bootstrap.entries)),
    })
  }

  for (const run of liveRuns) {
    if (!unmatched.has(run.runId)) {
      continue
    }
    reconciled.push({
      agentId: run.agentId,
      content: '',
      rootMessageId: run.rootMessageId,
      runId: run.runId,
      seededFromBootstrap: true,
      thinking: toThinkingEntries(run.entries),
    })
  }

  return reconciled
}

// Runs whose reply will land in one reply thread (the thread panel's surface).
export const selectPendingForRoot = (
  pending: PendingStreamMessage[],
  rootMessageId: string | null | undefined,
): PendingStreamMessage[] =>
  rootMessageId
    ? pending.filter((entry) => entry.rootMessageId === rootMessageId)
    : []

// Thread-anchored runs indexed by root, so the main feed can drop a compact
// bubble under the message the reply will hang from.
export const groupPendingByRoot = (
  pending: PendingStreamMessage[],
): Map<string, PendingStreamMessage[]> => {
  const grouped = new Map<string, PendingStreamMessage[]>()

  for (const entry of pending) {
    if (!entry.rootMessageId) {
      continue
    }
    const existing = grouped.get(entry.rootMessageId)
    if (existing) {
      existing.push(entry)
    } else {
      grouped.set(entry.rootMessageId, [entry])
    }
  }

  return grouped
}

// Scroll-pin input: the ticker growing is as much a layout change as a new row.
export const countThinkingEntries = (pending: PendingStreamMessage[]): number =>
  pending.reduce((total, entry) => total + entry.thinking.length, 0)
