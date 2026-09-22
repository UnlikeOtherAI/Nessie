import { codingHostSpawnPending } from './host-spawn.js'
import {
  encodeEventCursor,
  parseEventCursor,
  readEventPage,
  type EventCursor,
} from './session-events.js'
import { readJson, writeJsonAtomic, type CodingSessionPaths } from './session-files.js'
import { hostLockIsStale, readHostLock } from './session-lock.js'
import { listRequests } from './session-requests.js'
import type { CodingSessionEvent, CodingSessionMeta, CodingSessionState, CodingSessionStatus } from './types.js'

/**
 * What `session_status` answers: non-blocking, at most 8 KB, with `status`,
 * `nextCursor` and `pendingNotice` serialised first so a truncation downstream
 * still keeps them.
 *
 * The bridge remembers how far it has delivered each session's events (a
 * session has exactly one owner, so that is the per-owner cursor), which lets
 * the model poll without carrying a cursor of its own. Status is derived at
 * read time: a session still marked working whose host has stopped
 * heartbeating is reported `interrupted` with reason `host_lost`.
 */
export const CODING_STATUS_MAX_BYTES = 8 * 1024

const SUMMARY_READ_BYTES = 256 * 1024
const EVENTS_READ_BYTES = 7 * 1024

export type DerivedCodingStatus = {
  status: CodingSessionStatus
  reason?: string
  hostLive: boolean
  hostStarting: boolean
  inboxPending: number
}

export const deriveCodingStatus = async (
  paths: CodingSessionPaths, state: CodingSessionState | undefined,
): Promise<DerivedCodingStatus> => {
  const lock = await readHostLock(paths.lock)
  const hostLive = lock !== undefined && !hostLockIsStale(lock)
  const hostStarting = !hostLive && await codingHostSpawnPending(paths)
  const inboxPending = (await listRequests(paths)).length
  const base = { hostLive, hostStarting, inboxPending }
  if (!state) {
    // No host has written anything yet. With nothing asked for and nothing starting, it never will.
    if (!hostLive && !hostStarting && inboxPending === 0) return { ...base, status: 'interrupted', reason: 'host_lost' }
    return { ...base, status: 'starting' }
  }
  if ((state.status === 'working' || state.status === 'starting') && !hostLive && !hostStarting) {
    return { ...base, status: 'interrupted', reason: 'host_lost' }
  }
  return { ...base, status: state.status, ...(state.reason ? { reason: state.reason } : {}) }
}

export const readDeliveredCursor = async (paths: CodingSessionPaths): Promise<EventCursor | undefined> => (
  parseEventCursor((await readJson<{ cursor?: unknown }>(paths.delivered))?.cursor)
)

const pendingNotice = (
  derived: DerivedCodingStatus, state: CodingSessionState | undefined, rotated: boolean,
): string => {
  const notes: string[] = []
  if (derived.reason === 'host_lost') {
    notes.push(derived.inboxPending > 0
      ? 'The session host stopped; a new one is starting to deliver your request.'
      : 'The session host stopped. Send a message to resume the session.')
  } else if (derived.hostStarting) {
    notes.push('The session host is starting.')
  }
  if (derived.inboxPending > 0 && derived.hostLive) notes.push(`${derived.inboxPending} request(s) not yet picked up.`)
  if (state?.queued) notes.push(`${state.queued} message(s) queued for the next turn.`)
  const denied = state?.lastResult?.permissionDenials.length ?? 0
  if (denied > 0 && (derived.status === 'waiting_for_input' || derived.status === 'interrupted')) {
    notes.push(`The coding agent was denied ${denied} action(s) that need approval; see permissionDenials.`)
  }
  if (rotated) notes.push('Older events were rotated away.')
  return notes.join(' ')
}

const turnEnded = (status: CodingSessionStatus): boolean => status !== 'working' && status !== 'starting'

const summarise = (events: readonly CodingSessionEvent[]): Record<string, unknown> => {
  const toolCounts: Record<string, number> = {}
  const filesTouched = new Set<string>()
  let lastAssistant: string | undefined
  for (const event of events) {
    if (event.kind === 'tool') {
      toolCounts[event.name] = (toolCounts[event.name] ?? 0) + 1
      if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(event.name) && event.summary) filesTouched.add(event.summary)
      if (event.name === 'edit' && event.summary) for (const file of event.summary.split(', ')) filesTouched.add(file)
    }
    if (event.kind === 'assistant') lastAssistant = event.text
  }
  return {
    newEvents: events.length,
    toolCounts,
    filesTouched: [...filesTouched].slice(-10),
    ...(lastAssistant ? { lastAssistant: lastAssistant.slice(0, 600) } : {}),
  }
}

export const composeCodingStatus = async (input: {
  paths: CodingSessionPaths
  meta: CodingSessionMeta
  state: CodingSessionState | undefined
  derived: DerivedCodingStatus
  detail: 'summary' | 'events'
  cursor?: EventCursor
}): Promise<Record<string, unknown>> => {
  const { paths, meta, state, derived } = input
  const generation = state?.eventsGeneration ?? 0
  const from = input.cursor ?? await readDeliveredCursor(paths)
  const page = await readEventPage(paths, generation, from, input.detail === 'events'
    ? { maxBytes: EVENTS_READ_BYTES, maxEvents: 200 }
    : { maxBytes: SUMMARY_READ_BYTES, maxEvents: 5_000 })
  const ended = turnEnded(derived.status)
  const start: EventCursor = from && !page.rotated ? from : { generation, offset: 0, seq: from?.seq ?? 0 }
  const cursorAfter = (keep: number): EventCursor => (
    keep === page.events.length ? page.next : keep === 0 ? start : page.positions[keep - 1]!
  )
  const build = (keep: number): Record<string, unknown> => {
    const next = cursorAfter(keep)
    const notice = pendingNotice(derived, state, page.rotated)
    return {
      status: derived.status,
      nextCursor: encodeEventCursor(next),
      ...(notice ? { pendingNotice: notice } : {}),
      ...(derived.reason ? { reason: derived.reason } : {}),
      sessionId: meta.sessionId,
      agent: meta.agent,
      root: meta.rootName,
      path: meta.path,
      title: meta.title,
      turn: state?.turn ?? 0,
      updatedAt: state?.updatedAt ?? meta.createdAt,
      ...(state?.queued ? { queuedMessages: state.queued } : {}),
      moreEvents: page.more || keep < page.events.length,
      ...(input.detail === 'events'
        ? { events: page.events.slice(0, keep) }
        : { summary: summarise(page.events.slice(0, keep)) }),
      ...(ended && state?.lastResult ? { lastResult: state.lastResult } : {}),
      ...(state?.permissionDenials.length ? { permissionDenials: state.permissionDenials.slice(-5) } : {}),
    }
  }
  let keep = page.events.length
  let answer = build(keep)
  while (Buffer.byteLength(JSON.stringify(answer)) > CODING_STATUS_MAX_BYTES && keep > 0) {
    keep = Math.floor(keep / 2)
    answer = build(keep)
  }
  if (Buffer.byteLength(JSON.stringify(answer)) > CODING_STATUS_MAX_BYTES && state?.lastResult) {
    answer = { ...answer, lastResult: { ...state.lastResult, text: state.lastResult.text.slice(0, 1_500) } }
  }
  if (keep > 0 || page.rotated) {
    await writeJsonAtomic(paths.delivered, { cursor: encodeEventCursor(cursorAfter(keep)) }).catch(() => undefined)
  }
  return answer
}
