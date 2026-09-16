import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { faChevronDown, faChevronUp } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useBlocker } from 'react-router-dom'
import {
  useIndexingRefresh,
  useStorageUsage,
  useUploadDriver,
} from '../../../../facades/knowledge/file-hooks'
import { readDroppedItems } from '../../../../hooks/useFileDrop'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import { formatBytes } from '../../../../lib/upload-xhr'
import { familyForFilename, familyTone, iconForFamily } from '../../../shared/file-icons'
import { ConfirmDialog } from '../../../shared/ConfirmDialog'
import { hasPendingIndexing } from './indexing-copy'
import {
  useUploadQueue,
  failureLine,
  queueHeadline,
  type UploadEntry,
  type UploadQueue as UploadQueueApi,
} from './useUploadQueue'

/**
 * Where the upload queue shows (uploads-and-indexing.md §2).
 *
 * It docks into the status bar rather than floating as a card, because a card
 * is `role="status"` with nothing to press and this strip has a Retry and a
 * Cancel on every row. On `single` there is no status bar to dock into, so the
 * Finder gives the same strip its own row at the foot of the screen for as
 * long as the queue is non-empty — a bar that is worth 28px only while
 * something is actually happening.
 *
 * `aria-live` is on the summary line and nowhere else: a screen reader
 * announcing "41%… 43%… 46%" for five files at once is not progress, it is
 * noise over the top of everything else the person is doing.
 */

const barWidth = (pct: number | undefined): string => `${Math.min(100, Math.max(0, pct ?? 0))}%`

const EntryRow = ({
  entry,
  onCancel,
  onRetry,
}: {
  entry: UploadEntry
  onCancel: (id: string) => void
  onRetry: (id: string) => void
}) => {
  const family = familyForFilename(entry.title)
  const error = failureLine(entry.state)
  const pct = entry.state.kind === 'uploading' ? entry.state.pct : undefined
  const settled = entry.state.kind !== 'queued' && entry.state.kind !== 'uploading'

  return (
    <li
      className="flex min-w-0 items-center gap-2 py-1"
      data-upload-entry={entry.id}
      data-upload-state={entry.state.kind}
    >
      <FontAwesomeIcon
        className="h-3 w-3 shrink-0"
        fixedWidth
        icon={iconForFamily(family)}
        style={{ color: `var(${familyTone[family]})` }}
      />
      <span className="min-w-0 flex-1 truncate text-xs text-[color:var(--tx)]">{entry.title}</span>
      {error ? (
        <span className="shrink-0 text-xs text-[color:var(--danger-text)]">{error}</span>
      ) : entry.state.kind === 'queued' ? (
        <span className="shrink-0 text-xs text-[color:var(--tx3)]">Waiting</span>
      ) : (
        <span className="flex shrink-0 items-center gap-2">
          <span className="block h-1 w-16 overflow-hidden rounded-full bg-[color:var(--overlay)]">
            <span
              className="block h-full rounded-full bg-[color:var(--accent)]"
              style={{ width: barWidth(pct) }}
            />
          </span>
          <span className="w-8 text-right text-xs text-[color:var(--tx3)]">
            {pct === undefined ? '' : `${pct}%`}
          </span>
        </span>
      )}
      {entry.state.kind === 'done' ? null : (
        <button
          className="shrink-0 rounded px-1 text-[color:var(--accent)] hover:underline"
          onClick={() => (settled ? onRetry(entry.id) : onCancel(entry.id))}
          type="button"
        >
          <span className="text-xs">{settled ? 'Retry' : 'Cancel'}</span>
        </button>
      )}
    </li>
  )
}

/**
 * The expanded rows are a band of their own *above* the status bar, not
 * content inside it: `.finder-status-bar` is a fixed 28px row, and a list that
 * grew inside it was drawn off the bottom of the window.
 */
export const UploadQueueRows = ({
  expanded,
  extraRows,
  queue,
}: {
  expanded: boolean
  /**
   * A live cross-space transfer's own row (2D's `TransferProgressRow`). It is
   * always visible, never behind the chevron, and it is mounted as a row of
   * its own: it says what a failed move and a failed copy each leave behind,
   * and a summary line wrapped around it would contradict it.
   */
  extraRows?: ReactNode
  queue: UploadQueueApi
}) => {
  const rows = expanded && queue.entries.length > 0
  if (!rows && !extraRows) return null
  return (
    <div
      className="max-h-[180px] min-w-0 flex-shrink-0 overflow-y-auto border-t border-[color:var(--sep)] bg-[color:var(--main)] px-[var(--page-gutter)] py-1 text-xs"
      data-upload-list
    >
      {extraRows}
      {rows ? (
        <ul className="min-w-0">
          {queue.entries.map((entry) => (
            <EntryRow
              entry={entry}
              key={entry.id}
              onCancel={queue.cancel}
              onRetry={queue.retry}
            />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * The warning that comes before the refusal (§6). The server is the authority
 * on the quota and stays it — this only says what is left, while there is
 * still time to drop something smaller.
 */
const StorageWarning = ({ queued }: { queued: number }) => {
  const { data } = useStorageUsage('organization')
  if (queued === 0 || !data?.limitBytes) return null
  const remaining = Number(data.limitBytes) - Number(data.usedBytes)
  if (!Number.isFinite(remaining) || remaining <= 0) return null
  const used = Number(data.usedBytes) / Number(data.limitBytes)
  if (used < 0.9) return null
  return (
    <span className="shrink-0 text-xs text-[color:var(--danger-text)]">
      This may exceed your storage — {formatBytes(remaining)} left
    </span>
  )
}

/**
 * The status-bar strip. Collapsed it is one sentence, a bar and two controls;
 * expanded it grows to the rows, capped so the strip can never eat the
 * columns above it.
 */
export const UploadQueueTray = ({
  expanded,
  onToggle,
  queue,
}: {
  expanded: boolean
  onToggle: () => void
  queue: UploadQueueApi
}) => {
  const empty = queue.entries.length === 0
  if (empty) return null

  const queued = queue.entries.filter((entry) => entry.state.kind === 'queued').length

  return (
    <span className="flex min-w-0 flex-1 items-center" data-upload-tray>
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-live="polite"
          className="min-w-0 truncate text-[color:var(--tx2)]"
          data-upload-summary
        >
          {queueHeadline(queue.entries)}
        </span>
        <>
            <span className="hidden h-1 w-24 shrink-0 overflow-hidden rounded-full bg-[color:var(--overlay)] sm:block">
              <span
                className="block h-full rounded-full bg-[color:var(--accent)]"
                style={{
                  width: `${queue.summary.total === 0
                    ? 0
                    : Math.round((queue.summary.done / queue.summary.total) * 100)}%`,
                }}
              />
            </span>
            <StorageWarning queued={queued} />
            <button
              aria-expanded={expanded}
              aria-label={expanded ? 'Hide upload details' : 'Show upload details'}
              className="shrink-0 rounded px-1 text-[color:var(--tx3)]"
              data-upload-toggle
              onClick={onToggle}
              type="button"
            >
              <FontAwesomeIcon className="h-3 w-3" icon={expanded ? faChevronDown : faChevronUp} />
            </button>
            <button
              className="shrink-0 rounded px-1 text-[color:var(--accent)] hover:underline"
              data-upload-cancel-all
              onClick={queue.summary.settled ? queue.dismiss : queue.cancelAll}
              type="button"
            >
              <span className="text-xs">{queue.summary.settled ? 'Dismiss' : 'Cancel all'}</span>
            </button>
        </>
      </span>
    </span>
  )
}

/**
 * Uploads do not survive the screen they were started from, so leaving is a
 * question rather than a silent cancellation. The same question is asked of
 * the browser's own unload, where there is no dialog to ask it with.
 */
export const UploadLeaveGuard = ({ queue }: { queue: UploadQueueApi }) => {
  const blocker = useBlocker(queue.busy)

  useEffect(() => {
    if (!queue.busy) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [queue.busy])

  return (
    <ConfirmDialog
      cancelLabel="Stay"
      confirmLabel="Leave"
      destructive
      onCancel={() => blocker.reset?.()}
      onConfirm={() => {
        queue.cancelAll()
        blocker.proceed?.()
      }}
      open={blocker.state === 'blocked'}
      title="Uploads are still running. Leave and cancel them?"
    />
  )
}


// ── What the Finder mounts ──────────────────────────────────────────────────

export type FinderUploads = {
  /** Whether the tray's per-file rows are open. Held here, not in the tray,
   *  because the rows render as a band above the status bar the tray sits in. */
  expanded: boolean
  toggleExpanded: () => void
  /** The file picker's own props; the toolbar's "Upload…" clicks it. */
  openPicker: () => void
  pickerRef: React.RefObject<HTMLInputElement | null>
  queue: UploadQueueApi
  /**
   * `onDragOver`/`onDrop` for a column that is not a place a file can live —
   * the root column, Latest, Shared with me. Doing nothing instead would let
   * the browser take the drop and navigate the tab to the dropped file.
   */
  refuseProps: {
    onDragOver: (event: DragEvent<HTMLElement>) => void
    onDrop: (event: DragEvent<HTMLElement>) => void
  }
  /** A sentence about the column, in place of the item count, for 3 seconds. */
  statusMessage: string | null
  notice: (message: string) => void
}

const REFUSED_HERE = 'Drop files into a folder to upload them'

/**
 * Everything the Finder needs to accept a file: the queue, the file picker,
 * the refusal for the columns that are not folders, and the one poll that
 * keeps an indexing glyph honest.
 *
 * `pages` is the loaded list of the open root folder — read only to decide
 * whether anything is still pending, which is the only thing that starts the
 * poll and the only thing that stops it.
 */
export const useFinderUploads = ({
  pages,
  spaceId,
}: {
  pages: readonly KnowledgePageRecord[]
  spaceId: string | undefined
}): FinderUploads => {
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const notice = useCallback((message: string) => {
    setStatusMessage(message)
    setTimeout(() => setStatusMessage((current) => (current === message ? null : current)), 3_000)
  }, [])

  const queue = useUploadQueue({ driver: useUploadDriver(), onNotice: notice })
  useIndexingRefresh(spaceId, hasPendingIndexing(pages))

  const [expanded, setExpanded] = useState(false)
  // A fresh drop after a settled one should not open into yesterday's list.
  const empty = queue.entries.length === 0
  useEffect(() => {
    if (empty) setExpanded(false)
  }, [empty])

  const pickerRef = useRef<HTMLInputElement>(null)
  const openPicker = useCallback(() => pickerRef.current?.click(), [])

  const refuse = useCallback((event: DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
    event.preventDefault()
    if (event.type === 'drop') notice(REFUSED_HERE)
    else event.dataTransfer.dropEffect = 'none'
  }, [notice])

  return {
    expanded,
    notice,
    openPicker,
    pickerRef,
    queue,
    refuseProps: { onDragOver: refuse, onDrop: refuse },
    statusMessage,
    toggleExpanded: useCallback(() => setExpanded((open) => !open), []),
  }
}

/**
 * One picker for the whole Finder, reading its files through the same walk a
 * drop goes through — one queue, one cap, one refusal sentence.
 */
export const FinderUploadInput = ({
  parentPageId,
  spaceId,
  uploads,
}: {
  parentPageId: string | null
  spaceId: string | undefined
  uploads: FinderUploads
}) => (
  <input
    className="hidden"
    data-finder-upload-input
    multiple
    onChange={(event) => {
      const files = Array.from(event.target.files ?? [])
      event.target.value = ''
      if (files.length === 0 || !spaceId) return
      void readDroppedItems([], files)
        .then((drop) => uploads.queue.enqueue(drop, { parentPageId, spaceId }))
    }}
    ref={uploads.pickerRef}
    type="file"
  />
)
