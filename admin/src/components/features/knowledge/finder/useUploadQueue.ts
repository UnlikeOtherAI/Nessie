import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  uploadFailureFrom,
  type UploadDriver,
  type UploadFailureCode,
} from '../../../../facades/knowledge/file-hooks'
import {
  DIRECTORIES_UNSUPPORTED_COPY,
  type FileDrop,
} from '../../../../hooks/useFileDrop'
import { isUploadAborted, type UploadStart } from '../../../../lib/upload-xhr'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import type { FinderUploadEntry } from './FinderFolderColumn'

/**
 * The Finder's upload queue (uploads-and-indexing.md §2).
 *
 * One queue per `DocumentsFinder`, holding every file a drop or the toolbar's
 * file picker handed over: the folders it has to create first, two uploads in
 * flight, a placeholder row in the folder each file is going into, and a
 * reason on every entry that did not make it.
 *
 * The rules that are not obvious:
 *
 * - **Two at a time.** All at once and forty XHRs contend for one connection
 *   pool with every bar crawling; one at a time and a 2 GB video blocks forty
 *   small PDFs.
 * - **Quota is a property of the drop, not of one file.** A 507 on any entry
 *   means every entry still queued would fail the same way, so they are marked
 *   `skipped/quota` at once rather than each taking its turn to fail. A 413 is
 *   the opposite: it is about that one file.
 * - **A cancel is not a failure to retry with the same words.** Aborting the
 *   request rejects with `UploadAbortedError` and the entry says "Cancelled".
 *
 * Everything above the hook is pure and exported, because that is what
 * `admin/test/upload-queue.test.ts` measures.
 */

/** Two uploads in flight; see the note above. */
export const MAX_IN_FLIGHT = 2

/** How long a clean queue stays on screen before it disappears. */
export const QUEUE_COLLAPSE_MS = 5_000

export type UploadEntryState =
  | { kind: 'queued' }
  | { kind: 'uploading'; pct?: number }
  | { kind: 'done'; pageId: string }
  // `CANCELLED` is not one of the server's refusals: it is the only failure
  // the person caused on purpose, and it must not read like one of theirs.
  | { kind: 'failed'; code: UploadFailureCode | 'CANCELLED'; message: string }
  | { kind: 'skipped'; reason: 'quota' | 'cancelled' }

export type UploadEntry = {
  id: string
  file: File
  /** The name it is filed under, which is the row's name too. */
  title: string
  targetSpaceId: string
  /** The folder the drop landed on; a dropped folder tree is created under it. */
  dropParentPageId: string | null
  /** `['Contracts', '2026']` for `Contracts/2026/lease.pdf`; empty for a file. */
  relativePath: string[]
  /**
   * Where it will actually be filed. `null` is the root of the space;
   * `undefined` means the folders in `relativePath` do not exist yet, so the
   * entry has no column to show a placeholder in.
   */
  targetParentPageId: string | null | undefined
  state: UploadEntryState
}

export type UploadTarget = { parentPageId: string | null; spaceId: string }

// ── Pure: ordering, concurrency, cascade, retry ─────────────────────────────

export const inFlightCount = (entries: readonly UploadEntry[]): number =>
  entries.filter((entry) => entry.state.kind === 'uploading').length

/**
 * The entries that may start now: drop order, never more than `MAX_IN_FLIGHT`
 * counting what is already going up.
 */
export const nextStartable = (
  entries: readonly UploadEntry[],
  limit = MAX_IN_FLIGHT,
): UploadEntry[] => {
  const room = Math.max(0, limit - inFlightCount(entries))
  if (room === 0) return []
  return entries.filter((entry) => entry.state.kind === 'queued').slice(0, room)
}

/**
 * Every folder path a drop needs, shallowest first and each one once — the
 * order the `POST /pages { kind: 'folder' }` calls go out in, so a child is
 * never created before its parent.
 */
export const folderPathsFor = (entries: readonly UploadEntry[]): string[][] => {
  const seen = new Map<string, string[]>()
  for (const entry of entries) {
    for (let depth = 1; depth <= entry.relativePath.length; depth += 1) {
      const path = entry.relativePath.slice(0, depth)
      const key = path.join('/')
      if (!seen.has(key)) seen.set(key, path)
    }
  }
  return [...seen.values()].sort((a, b) => a.length - b.length)
}

const FAILURE_COPY: Record<UploadFailureCode | 'CANCELLED', (message: string) => string> = {
  STORAGE_QUOTA_EXCEEDED: () => 'Not uploaded — storage is full',
  // The per-file ceiling is the server's `NESSIE_MAX_UPLOAD_BYTES` and is not
  // published to the client, so the row says what happened rather than
  // inventing a number it would be wrong about the day the limit moves.
  FILE_TOO_LARGE: () => 'Too large to upload',
  NETWORK: () => 'Not uploaded — the upload failed',
  REFUSED: (message) => `Not uploaded — ${message}`,
  CANCELLED: () => 'Cancelled',
}

export const failureLine = (state: UploadEntryState): string | null => {
  if (state.kind === 'failed') return FAILURE_COPY[state.code](state.message)
  if (state.kind === 'skipped') {
    return state.reason === 'quota' ? 'Skipped — storage is full' : 'Cancelled'
  }
  return null
}

/**
 * A 507 on one entry settles the whole drop: the ones still queued would fail
 * the same way, and forty rows failing one by one over a minute is the same
 * news told forty times.
 */
export const cascadeQuota = (
  entries: readonly UploadEntry[],
  failedId: string,
  message: string,
): UploadEntry[] => entries.map((entry) => {
  if (entry.id === failedId) {
    return { ...entry, state: { code: 'STORAGE_QUOTA_EXCEEDED', kind: 'failed', message } }
  }
  if (entry.state.kind === 'queued') {
    return { ...entry, state: { kind: 'skipped', reason: 'quota' } }
  }
  return entry
})

const isQuotaCasualty = (entry: UploadEntry): boolean =>
  (entry.state.kind === 'skipped' && entry.state.reason === 'quota')
  || (entry.state.kind === 'failed' && entry.state.code === 'STORAGE_QUOTA_EXCEEDED')

/**
 * Retry. On anything the storage quota stopped it re-queues the whole group,
 * because one file at a time into a full bucket is forty more refusals; on any
 * other failure it re-queues only the entry that was clicked.
 */
export const retryFrom = (entries: readonly UploadEntry[], id: string): UploadEntry[] => {
  const target = entries.find((entry) => entry.id === id)
  if (!target) return [...entries]
  const group = isQuotaCasualty(target)
  return entries.map((entry) => {
    if (group ? isQuotaCasualty(entry) : entry.id === id) {
      return { ...entry, state: { kind: 'queued' } }
    }
    return entry
  })
}

export type QueueSummary = {
  active: number
  done: number
  failed: number
  settled: boolean
  total: number
}

export const queueSummary = (entries: readonly UploadEntry[]): QueueSummary => {
  const done = entries.filter((entry) => entry.state.kind === 'done').length
  const failed = entries.filter(
    (entry) => entry.state.kind === 'failed' || entry.state.kind === 'skipped',
  ).length
  const active = entries.length - done - failed
  return { active, done, failed, settled: active === 0, total: entries.length }
}

/** "5 files uploaded" · "4 of 5 uploaded — 1 failed". */
export const queueSummaryLine = (entries: readonly UploadEntry[]): string => {
  const { done, failed, total } = queueSummary(entries)
  const noun = done === 1 ? 'file' : 'files'
  if (failed === 0) return `${done} ${noun} uploaded`
  return `${done} of ${total} uploaded — ${failed} failed`
}

/** The collapsed line: "Uploading 2 of 5 · lease.pdf 40%". */
export const queueHeadline = (entries: readonly UploadEntry[]): string => {
  const { active, done, total } = queueSummary(entries)
  if (active === 0) return queueSummaryLine(entries)
  const current = entries.find((entry) => entry.state.kind === 'uploading') ?? null
  const position = Math.min(total, done + 1)
  const pct = current?.state.kind === 'uploading' ? current.state.pct : undefined
  const tail = current
    ? ` · ${current.title}${pct === undefined ? '' : ` ${pct}%`}`
    : ''
  return `Uploading ${position} of ${total}${tail}`
}

/**
 * The placeholder rows one column draws (§3). A `done` entry has none: the
 * real row arrived with the next `pages` fetch and two rows for one file is
 * the flash the placeholder exists to prevent.
 */
export const placeholdersIn = (
  entries: readonly UploadEntry[],
  parentPageId: string | null,
): FinderUploadEntry[] => entries
  .filter((entry) => entry.state.kind !== 'done' && entry.targetParentPageId === parentPageId)
  .map((entry) => {
    const error = failureLine(entry.state)
    const pct = entry.state.kind === 'uploading' ? entry.state.pct : undefined
    return {
      id: entry.id,
      title: entry.title,
      upload: {
        ...(error ? { error } : {}),
        ...(pct === undefined ? {} : { pct }),
        label: entry.state.kind === 'queued'
          ? 'Waiting'
          : pct === undefined ? 'Uploading…' : `Uploading… ${pct}%`,
      },
    }
  })

// ── The hook ────────────────────────────────────────────────────────────────

export type UploadQueue = {
  cancel: (id: string) => void
  cancelAll: () => void
  /** True while anything is queued or going up — what the leave guard reads. */
  busy: boolean
  /** Drops every settled entry and closes the tray. */
  dismiss: () => void
  enqueue: (drop: FileDrop, target: UploadTarget) => void
  entries: UploadEntry[]
  placeholdersFor: (parentPageId: string | null) => FinderUploadEntry[]
  retry: (id: string) => void
  summary: QueueSummary
}

type UseUploadQueueInput = {
  driver: UploadDriver
  /**
   * A refusal, or the one notice a browser without the directory API earns.
   * The queue never swallows a file it decided not to take.
   */
  onNotice: (message: string) => void
}

let sequence = 0
const nextId = (): string => {
  sequence += 1
  return `upload-${sequence}-${Date.now().toString(36)}`
}

export const useUploadQueue = ({ driver, onNotice }: UseUploadQueueInput): UploadQueue => {
  const [entries, setEntries] = useState<UploadEntry[]>([])
  // The runner reads the live list rather than the render it was created in:
  // a start decision taken against a stale list starts a third upload.
  const live = useRef<UploadEntry[]>([])
  live.current = entries
  const requests = useRef(new Map<string, UploadStart<KnowledgePageRecord>>())
  const running = useRef(new Set<string>())
  const cancelling = useRef(new Set<string>())
  // One `POST` per folder path, shared by every file inside it.
  const folders = useRef(new Map<string, Promise<string>>())
  const driverRef = useRef(driver)
  driverRef.current = driver
  const noticeRef = useRef(onNotice)
  noticeRef.current = onNotice

  const patch = useCallback((id: string, state: UploadEntryState) => {
    setEntries((prev) => prev.map((entry) => (entry.id === id ? { ...entry, state } : entry)))
  }, [])

  const ensureFolders = useCallback(async (entry: UploadEntry): Promise<string | null> => {
    let parent = entry.dropParentPageId
    for (let depth = 0; depth < entry.relativePath.length; depth += 1) {
      const path = entry.relativePath.slice(0, depth + 1).join('/')
      const key = `${entry.targetSpaceId}|${entry.dropParentPageId ?? 'root'}|${path}`
      let pending = folders.current.get(key)
      if (!pending) {
        const under = parent
        pending = driverRef.current
          .createFolder({
            parentPageId: under,
            spaceId: entry.targetSpaceId,
            title: entry.relativePath[depth] ?? 'Folder',
          })
          .then((page) => page.id)
        folders.current.set(key, pending)
      }
      parent = await pending
    }
    if (entry.relativePath.length > 0) driverRef.current.invalidateSpace(entry.targetSpaceId)
    return parent
  }, [])

  const start = useCallback(async (entry: UploadEntry): Promise<void> => {
    running.current.add(entry.id)
    patch(entry.id, { kind: 'uploading' })

    let parentPageId = entry.targetParentPageId ?? null
    if (entry.targetParentPageId === undefined) {
      try {
        parentPageId = await ensureFolders(entry)
        setEntries((prev) => prev.map((row) => (
          row.id === entry.id ? { ...row, targetParentPageId: parentPageId } : row
        )))
      } catch (error) {
        running.current.delete(entry.id)
        patch(entry.id, {
          code: 'REFUSED',
          kind: 'failed',
          message: error instanceof Error ? error.message : 'Folder could not be created',
        })
        return
      }
    }

    const request = driverRef.current.startUpload({
      file: entry.file,
      onProgress: (progress) => patch(entry.id, { kind: 'uploading', pct: progress.pct }),
      parentPageId,
      spaceId: entry.targetSpaceId,
      title: entry.title,
    })
    requests.current.set(entry.id, request)

    try {
      const page = await request.result
      if (cancelling.current.has(entry.id)) {
        // The abort lost the race with the server's commit: the bytes are
        // stored and a page exists. Nothing half-arrived is allowed to linger.
        void driverRef.current.deletePage(page.id).catch(() => undefined)
        patch(entry.id, { kind: 'skipped', reason: 'cancelled' })
      } else {
        patch(entry.id, { kind: 'done', pageId: page.id })
        driverRef.current.invalidateSpace(entry.targetSpaceId)
      }
    } catch (error) {
      if (isUploadAborted(error)) {
        patch(entry.id, { code: 'CANCELLED', kind: 'failed', message: 'Cancelled' })
      } else {
        const failure = uploadFailureFrom(error, request.xhr.status)
        if (failure.code === 'STORAGE_QUOTA_EXCEEDED') {
          setEntries((prev) => cascadeQuota(prev, entry.id, failure.message))
        } else {
          patch(entry.id, { code: failure.code, kind: 'failed', message: failure.message })
        }
      }
    } finally {
      cancelling.current.delete(entry.id)
      requests.current.delete(entry.id)
      running.current.delete(entry.id)
    }
  }, [ensureFolders, patch])

  // The runner. It fires on every state change because every state change is
  // one of the two things that can free a slot: something settled, or
  // something new arrived.
  useEffect(() => {
    for (const entry of nextStartable(live.current)) {
      if (running.current.has(entry.id)) continue
      void start(entry)
    }
  }, [entries, start])

  const summary = useMemo(() => queueSummary(entries), [entries])

  // A clean run disappears on its own; a run with a failure in it stays until
  // the person has read it and said so.
  useEffect(() => {
    if (entries.length === 0 || !summary.settled || summary.failed > 0) return
    const timer = setTimeout(() => setEntries([]), QUEUE_COLLAPSE_MS)
    return () => clearTimeout(timer)
  }, [entries.length, summary.failed, summary.settled])

  // Leaving the Finder stops the transfers; nothing keeps uploading into a
  // screen nobody can see the progress of.
  useEffect(() => () => {
    for (const request of requests.current.values()) request.abort()
  }, [])

  const enqueue = useCallback((drop: FileDrop, target: UploadTarget) => {
    // Said first and always: a browser that cannot read a dropped folder has
    // already thrown those entries away, and so has the heuristic that cannot
    // tell an empty file from one.
    if (drop.directoriesUnsupported) noticeRef.current(DIRECTORIES_UNSUPPORTED_COPY)
    if (drop.refusal) {
      noticeRef.current(drop.refusal.message)
      return
    }
    if (drop.entries.length === 0) return
    setEntries((prev) => [
      ...prev,
      ...drop.entries.map((dropped) => ({
        dropParentPageId: target.parentPageId,
        file: dropped.file,
        id: nextId(),
        relativePath: dropped.relativePath,
        state: { kind: 'queued' } as UploadEntryState,
        targetParentPageId: dropped.relativePath.length === 0
          ? target.parentPageId
          : undefined,
        targetSpaceId: target.spaceId,
        title: dropped.file.name,
      })),
    ])
  }, [])

  const cancel = useCallback((id: string) => {
    const request = requests.current.get(id)
    if (request) {
      cancelling.current.add(id)
      request.abort()
      return
    }
    setEntries((prev) => prev.map((entry) => (
      entry.id === id && entry.state.kind === 'queued'
        ? { ...entry, state: { kind: 'skipped', reason: 'cancelled' } }
        : entry
    )))
  }, [])

  const cancelAll = useCallback(() => {
    for (const [id, request] of requests.current.entries()) {
      cancelling.current.add(id)
      request.abort()
    }
    setEntries((prev) => prev.map((entry) => (
      entry.state.kind === 'queued'
        ? { ...entry, state: { kind: 'skipped', reason: 'cancelled' } }
        : entry
    )))
  }, [])

  const retry = useCallback((id: string) => setEntries((prev) => retryFrom(prev, id)), [])

  const dismiss = useCallback(() => {
    setEntries((prev) => prev.filter((entry) => (
      entry.state.kind === 'queued' || entry.state.kind === 'uploading'
    )))
  }, [])

  const placeholdersFor = useCallback(
    (parentPageId: string | null) => placeholdersIn(live.current, parentPageId),
    // `entries` is the dependency in spirit: the ref is read at call time, and
    // the identity has to change with the list or a column memoises its rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries],
  )

  return {
    busy: summary.active > 0,
    cancel,
    cancelAll,
    dismiss,
    enqueue,
    entries,
    placeholdersFor,
    retry,
    summary,
  }
}
