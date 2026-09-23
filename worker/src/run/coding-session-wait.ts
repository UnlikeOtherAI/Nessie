import { EXECUTOR_TOOL_TIMEOUT_MARGIN_MS } from '@nessie/schemas'

import type { AgenticToolResult } from './tools.js'

/**
 * `coding_session_wait`, done by the worker rather than the machine.
 *
 * The bridge's `session_status` never waits, so the wait is a series of short
 * reads, one every five seconds for up to ten minutes, and between them
 * nothing is outstanding on the executor's one command lane: another run's
 * command, or this run's next one, never queues behind a sleep. It returns
 * early when the session needs the model — its turn ended, it was
 * interrupted, it failed or closed — and when the model should stop watching:
 * the person wrote in this conversation, the run was stopped, the worker is
 * handing the run over, or the run's own time reaches its wind-down.
 *
 * The window is long because every return costs a full-context inference:
 * a coding turn of twenty minutes is two waits, not five. It ends at the run's
 * wind-down all the same, so an agent whose run is nearly out of time still
 * has the time to say where the session stands.
 *
 * Only one read can end in an unknown outcome, and only as any command does:
 * its own expiry. Every read's command expires no later than the wait's own
 * deadline, a margin inside the tool's timeout, so the batch's backstop never
 * fires on a wait that was merely sleeping. A late read whose expiry the
 * deadline shortened is not an unknown outcome at all — a status read changes
 * nothing on the machine — and ends the wait with what it has.
 *
 * What the model gets is a digest of at most 1.5 KB — status, turn, the coding
 * agent's tool calls by name since the last wait, the files it touched and its
 * last sentence — and the full final summary only once a turn has ended.
 */

export const CODING_WAIT_POLL_MS = 5_000
export const CODING_WAIT_WINDOW_MS = 10 * 60_000
export const CODING_WAIT_TOOL_TIMEOUT_MS = 10.5 * 60_000
export const CODING_WAIT_DIGEST_MAX_BYTES = 1_536

/** A `session_status` answer, as the bridge serialised it. */
export type CodingStatusBody = Record<string, unknown>

export type CodingWaitPoll =
  | { kind: 'answer'; body: CodingStatusBody }
  | { kind: 'failed'; result: AgenticToolResult }
  /** The read's command expired at the wait's own deadline, shorter than its TTL. */
  | { kind: 'expired' }

export type CodingWaitOutcome =
  /** The session needs the model: its turn ended, it was interrupted, it failed or it closed. */
  | 'attention'
  /** Ten minutes passed and the coding agent is still working. */
  | 'window'
  | 'person_wrote'
  | 'cancelled'
  | 'drained'
  /** The run's own time reached its wind-down; the coding agent may still be working. */
  | 'run_ending'
  /** The last read came back too late to count. */
  | 'no_answer'

export type CodingWaitActivity = {
  files: string[]
  lastAssistant?: string
  /** The coding agent's latest tool call, as the bridge projected it: its name and one-line input summary. */
  lastTool?: { name: string; summary: string }
  newEvents: number
  toolCounts: Map<string, number>
}

export type CodingWaitDone = {
  activity: CodingWaitActivity
  kind: 'done'
  last: CodingStatusBody
  outcome: CodingWaitOutcome
  waitedMs: number
}

export type CodingWaitTiming = {
  now?: () => number
  pollMs?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  timeoutMs?: number
  windowMs?: number
}

export type CodingWaitInput = {
  /**
   * The turn a start or a send this run made is still owed: until the session
   * reports a later turn, a status that says the last one ended is the old
   * answer, not the one being waited for.
   */
  awaitTurnAbove?: number
  onProgress?: (body: CodingStatusBody, activity: CodingWaitActivity) => Promise<void>
  /** Whether the person has written to this agent in this conversation since the run began. */
  personWrote: () => Promise<boolean>
  /** One `session_status` read, whose command expires no later than `expiresBy`. */
  poll: (index: number, expiresBy: Date) => Promise<CodingWaitPoll>
  /**
   * When the run's own wallclock enters its wind-down (epoch ms): the wait
   * ends there rather than hold the agent past the point it should be
   * wrapping up. Past it already, the wait reads once and returns.
   */
  runWindDownAt?: number
  /** The worker is draining: stop at once and hand back what there is. */
  signal?: AbortSignal
  stopRequested: () => Promise<boolean>
  timing?: CodingWaitTiming
}

const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((settle) => {
  if (signal?.aborted) {
    settle()
    return
  }
  const done = (): void => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', done)
    settle()
  }
  const timer = setTimeout(done, ms)
  signal?.addEventListener('abort', done, { once: true })
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// The bridge's own words for work already asked for and not yet begun
// (`pendingNotice` in executor/src/coding-session/status.ts).
const PENDING_REQUEST_NOTICE =
  /request\(s\) not yet picked up|session host is starting|starting to deliver your request/

/** A message or a start the host has not picked up yet: the session is about to work. */
export const codingRequestPending = (body: CodingStatusBody): boolean =>
  (typeof body.queuedMessages === 'number' && body.queuedMessages > 0)
  || (typeof body.pendingNotice === 'string' && PENDING_REQUEST_NOTICE.test(body.pendingNotice))

/** Whether this answer is one the model has to act on. */
export const codingSessionNeedsModel = (body: CodingStatusBody, awaitTurnAbove?: number): boolean => {
  switch (body.status) {
    case 'starting':
    case 'working':
      return false
    case 'waiting_for_input':
    case 'interrupted':
      if (codingRequestPending(body)) return false
      // The host picked the request up, but the turn it starts has not been
      // written yet; a categorical reason (a lost host) is news of its own.
      return !(awaitTurnAbove !== undefined && body.reason === undefined
        && typeof body.turn === 'number' && body.turn <= awaitTurnAbove)
    default:
      // failed, closed, and any status this release does not know.
      return true
  }
}

const FILES_KEPT = 10

const absorb = (activity: CodingWaitActivity, body: CodingStatusBody): void => {
  const summary = isRecord(body.summary) ? body.summary : {}
  if (typeof summary.newEvents === 'number') activity.newEvents += summary.newEvents
  if (isRecord(summary.toolCounts)) {
    for (const [name, count] of Object.entries(summary.toolCounts)) {
      if (typeof count === 'number') activity.toolCounts.set(name, (activity.toolCounts.get(name) ?? 0) + count)
    }
  }
  if (Array.isArray(summary.filesTouched)) {
    for (const file of summary.filesTouched) {
      if (typeof file !== 'string') continue
      const at = activity.files.indexOf(file)
      if (at >= 0) activity.files.splice(at, 1)
      activity.files.push(file)
    }
    activity.files.splice(0, Math.max(0, activity.files.length - FILES_KEPT))
  }
  if (typeof summary.lastAssistant === 'string' && summary.lastAssistant.trim()) {
    activity.lastAssistant = summary.lastAssistant
  }
  const tool = isRecord(summary.lastTool) ? summary.lastTool : null
  if (tool && typeof tool.name === 'string' && typeof tool.summary === 'string') {
    activity.lastTool = { name: tool.name, summary: tool.summary }
  }
}

/** Polls until the session needs the model, the window closes, or the model should stop watching. */
export const runCodingSessionWait = async (
  input: CodingWaitInput,
): Promise<CodingWaitDone | { kind: 'failed'; result: AgenticToolResult }> => {
  const now = input.timing?.now ?? Date.now
  const sleep = input.timing?.sleep ?? abortableSleep
  const pollMs = input.timing?.pollMs ?? CODING_WAIT_POLL_MS
  const windowMs = input.timing?.windowMs ?? CODING_WAIT_WINDOW_MS
  const startedAt = now()
  const timeoutMs = input.timing?.timeoutMs ?? CODING_WAIT_TOOL_TIMEOUT_MS
  const deadline = new Date(startedAt + timeoutMs - EXECUTOR_TOOL_TIMEOUT_MARGIN_MS)
  const activity: CodingWaitActivity = { files: [], newEvents: 0, toolCounts: new Map() }
  let last: CodingStatusBody | undefined
  const done = (outcome: CodingWaitOutcome): CodingWaitDone => ({
    activity, kind: 'done', last: last ?? {}, outcome, waitedMs: now() - startedAt,
  })
  // Drain first: a stopping worker has seconds, not minutes, to hand the run over.
  const stopWatching = async (): Promise<CodingWaitOutcome | null> => {
    if (input.signal?.aborted) return 'drained'
    if (await input.stopRequested()) return 'cancelled'
    if (await input.personWrote()) return 'person_wrote'
    return null
  }
  for (let index = 0; ; index += 1) {
    const polled = await input.poll(index, deadline)
    if (polled.kind === 'failed') return polled
    if (polled.kind === 'expired') return done('no_answer')
    last = polled.body
    absorb(activity, last)
    if (codingSessionNeedsModel(last, input.awaitTurnAbove)) return done('attention')
    const early = await stopWatching()
    if (early) return done(early)
    if (now() - startedAt + pollMs >= windowMs) return done('window')
    if (input.runWindDownAt !== undefined && now() + pollMs >= input.runWindDownAt) return done('run_ending')
    await input.onProgress?.(last, activity).catch(() => undefined)
    await sleep(pollMs, input.signal)
    const late = await stopWatching()
    if (late) return done(late)
  }
}

/* -------------------------------------------------------------------------- */
/* The digest                                                                  */
/* -------------------------------------------------------------------------- */

const oneLine = (value: unknown, max: number): string => {
  const flat = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** The last sentence of what the coding agent said, on one line. */
export const lastSentence = (text: string | undefined, max = 300): string | undefined => {
  const flat = oneLine(text, 4_096)
  if (!flat) return undefined
  const sentences = flat.split(/(?<=[.!?])\s+/u).filter(Boolean)
  return oneLine(sentences.at(-1) ?? flat, max)
}

/** Tool calls by name, most used first. */
const rankedTools = (counts: Map<string, number>): Array<[string, number]> =>
  [...counts.entries()].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))

export const codingSteps = (activity: CodingWaitActivity): number =>
  [...activity.toolCounts.values()].reduce((sum, count) => sum + count, 0)

const toolCallsDigest = (counts: Map<string, number>, keep: number): Record<string, number> => {
  const ranked = rankedTools(counts)
  const shown = Object.fromEntries(ranked.slice(0, keep).map(([name, count]) => [oneLine(name, 40), count]))
  const rest = ranked.slice(keep).reduce((sum, [, count]) => sum + count, 0)
  return rest > 0 ? { ...shown, other: rest } : shown
}

const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

/**
 * The wait's digest: status first, so a reader who stops early still has it,
 * then what the coding agent did since the last wait. Shrunk field by field
 * until it fits `CODING_WAIT_DIGEST_MAX_BYTES`.
 */
export const codingWaitDigest = (done: CodingWaitDone): Record<string, unknown> => {
  const { activity, last } = done
  const variant = (level: number): Record<string, unknown> => {
    const sentence = level >= 6 ? undefined : lastSentence(activity.lastAssistant, level >= 1 ? 150 : 300)
    const files = level >= 5
      ? []
      : activity.files.slice(level >= 2 ? -5 : -FILES_KEPT).map((file) => oneLine(file, 120))
    const notice = level >= 4 ? '' : oneLine(last.pendingNotice, 300)
    const title = level >= 4 ? '' : oneLine(last.title, 120)
    return {
      status: typeof last.status === 'string' ? last.status : 'unknown',
      ...(typeof last.reason === 'string' ? { reason: oneLine(last.reason, 64) } : {}),
      turn: typeof last.turn === 'number' ? last.turn : 0,
      ...(title ? { title } : {}),
      waitedSeconds: Math.round(done.waitedMs / 1_000),
      steps: codingSteps(activity),
      toolCalls: toolCallsDigest(activity.toolCounts, level >= 3 ? 4 : 8),
      ...(files.length > 0 ? { filesTouched: files } : {}),
      ...(sentence ? { lastSentence: sentence } : {}),
      ...(typeof last.queuedMessages === 'number' ? { queuedMessages: last.queuedMessages } : {}),
      ...(typeof last.backgroundTasks === 'number' ? { backgroundTasks: last.backgroundTasks } : {}),
      ...(notice ? { notice } : {}),
    }
  }
  for (let level = 0; level < 7; level += 1) {
    const digest = variant(level)
    if (byteLength(digest) <= CODING_WAIT_DIGEST_MAX_BYTES) return digest
  }
  return variant(7)
}

/** The turn's own end, carried only once a turn has ended: the full summary and what was denied. */
export const codingTurnEnd = (last: CodingStatusBody): Record<string, unknown> | null => {
  const result = isRecord(last.lastResult) ? last.lastResult : null
  if (!result || (last.status !== 'waiting_for_input' && last.status !== 'interrupted')) return null
  const denials = Array.isArray(result.permissionDenials) && result.permissionDenials.length > 0
    ? result.permissionDenials
    : Array.isArray(last.permissionDenials) ? last.permissionDenials : []
  return {
    finalSummary: typeof result.text === 'string' ? result.text : '',
    ...(result.isError === true ? { isError: true } : {}),
    ...(denials.length > 0 ? { permissionDenials: denials } : {}),
  }
}
