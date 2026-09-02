/**
 * A durable queue for per-turn usage reports.
 *
 * Usage is the only account anyone has of what a call cost — Google exposes no
 * per-session metering — so a report that dies with the tab is spend nobody
 * can attribute. Coder's iOS reporter keeps its queue in actor memory and
 * gives up after three drain attempts; this one survives a reload, a crash, or
 * a closed laptop, and replays in exact sequence on the next visit.
 *
 * `localStorage` rather than IndexedDB: the payloads are tiny and few (one per
 * conversational turn), and a synchronous store means a report enqueued during
 * `beforeunload` is already persisted when the tab dies. Every access is
 * wrapped because private-mode browsers throw on `localStorage` access itself,
 * and losing telemetry must never break a call.
 */

const STORAGE_KEY = 'nessie.voice.usage-outbox'
const TRANSCRIPT_KEY = 'nessie.voice.transcript-outbox'
/**
 * Cap on retained reports. A pathological offline session should not grow the
 * store without bound; oldest entries go first because newer ones carry the
 * larger cumulative totals.
 */
const MAX_ENTRIES = 200

export type UsageReport = {
  voiceSessionId: string
  sequence: number
  model: string
  usage: Record<string, unknown> | null
  complete: boolean
}

const read = (): UsageReport[] => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as UsageReport[]) : []
  } catch {
    return []
  }
}

const write = (entries: UsageReport[]): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)))
  } catch {
    // Quota or a store that refuses access. The call continues either way.
  }
}

export const enqueueUsageReport = (report: UsageReport): void => {
  const entries = read()
  // The server is idempotent on (session, sequence), but replaying a duplicate
  // wastes a request per turn on a flaky connection, so drop it here too.
  const exists = entries.some(
    (entry) =>
      entry.voiceSessionId === report.voiceSessionId && entry.sequence === report.sequence,
  )
  if (exists) return
  write([...entries, report])
}

export const pendingUsageReports = (): UsageReport[] =>
  // Ascending sequence per session: Ledger accepts reports in order and
  // rejects a stale one with a conflict, so replay must not shuffle them.
  read().sort((a, b) =>
    a.voiceSessionId === b.voiceSessionId
      ? a.sequence - b.sequence
      : a.voiceSessionId.localeCompare(b.voiceSessionId),
  )

export const removeUsageReport = (voiceSessionId: string, sequence: number): void => {
  write(
    read().filter(
      (entry) => !(entry.voiceSessionId === voiceSessionId && entry.sequence === sequence),
    ),
  )
}

export type UsageDrainDeps = {
  /** Posts one report; resolves on acceptance, rejects to keep it queued. */
  send: (report: UsageReport) => Promise<void>
}

/**
 * Drains the outbox, stopping at the first failure.
 *
 * Stopping rather than skipping is deliberate: sequences must arrive in order,
 * so a report that cannot be delivered blocks the ones behind it until the
 * next drain. A report the server permanently rejects (a 4xx that is not a
 * conflict) is dropped, because retrying it forever would wedge the queue.
 */
export const drainUsageOutbox = async (deps: UsageDrainDeps): Promise<void> => {
  for (const report of pendingUsageReports()) {
    try {
      await deps.send(report)
      removeUsageReport(report.voiceSessionId, report.sequence)
    } catch (error) {
      if (isPermanentRejection(error)) {
        removeUsageReport(report.voiceSessionId, report.sequence)
        continue
      }
      return
    }
  }
}

const isPermanentRejection = (error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status
  // 409 means a newer report already landed — the queue is behind, not wrong,
  // and the entry is safe to drop. Other 4xx are malformed or unauthorized and
  // will never succeed. 5xx and network errors stay queued.
  return typeof status === 'number' && status >= 400 && status < 500
}

/**
 * A call record waiting to be written.
 *
 * The transcript only exists on the device that heard the call, so a tab that
 * dies mid-call is the one case where the record is unrecoverable. Buffering
 * it beside the usage reports means the next visit writes it — the server
 * accepts a record for an ended call precisely so this can work.
 */
export type PendingTranscript = {
  voiceSessionId: string
  lines: Array<{ speaker: 'user' | 'assistant'; text: string; atMs: number }>
  durationMs: number
}

const readTranscripts = (): PendingTranscript[] => {
  try {
    const raw = window.localStorage.getItem(TRANSCRIPT_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as PendingTranscript[]) : []
  } catch {
    return []
  }
}

const writeTranscripts = (entries: PendingTranscript[]): void => {
  try {
    window.localStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(entries.slice(-10)))
  } catch {
    // A call that cannot buffer its record still completes.
  }
}

/** Records the in-progress transcript, replacing any earlier snapshot of it. */
export const stashTranscript = (entry: PendingTranscript): void => {
  writeTranscripts([
    ...readTranscripts().filter((held) => held.voiceSessionId !== entry.voiceSessionId),
    entry,
  ])
}

export const clearTranscript = (voiceSessionId: string): void => {
  writeTranscripts(readTranscripts().filter((held) => held.voiceSessionId !== voiceSessionId))
}

export const pendingTranscripts = (): PendingTranscript[] => readTranscripts()

/**
 * Submits buffered call records.
 *
 * A permanent rejection drops the entry: the commonest is the server already
 * holding a record for that call, which means the work is done, not lost.
 */
export const drainTranscriptOutbox = async (deps: {
  send: (entry: PendingTranscript) => Promise<void>
}): Promise<void> => {
  for (const entry of readTranscripts()) {
    try {
      await deps.send(entry)
      clearTranscript(entry.voiceSessionId)
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status
      if (typeof status === 'number' && status >= 400 && status < 500) {
        clearTranscript(entry.voiceSessionId)
        continue
      }
      return
    }
  }
}
