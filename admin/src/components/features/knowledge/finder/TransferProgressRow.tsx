import { faArrowRotateRight, faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { transferProgressSentence, type TransferProgress } from './transfer-copy'

/**
 * One queued transfer in the status-bar tray — the upload queue's sibling row
 * (transfer.md §5.4), mounted by the tray, not by this file.
 *
 * It exists because above `TRANSFER_SYNCHRONOUS_MAX_PAGES` the request answers
 * 202 and the work happens in a worker: without a row here a person who dragged
 * 1,800 pages would see nothing happen and drag again.
 *
 * **The failure sentence is operation-specific and that is deliberate.** A
 * failed copy rolled back — nothing was created and nothing was charged. A
 * failed move kept the batches that committed, which means some of the person's
 * documents are in the new place and the rest are not. Retry re-issues the
 * transfer over what is left; it is an ordinary new request, so it goes through
 * the same refusals, and anything the server will not do it says here.
 */

export type TransferProgressRowProps = {
  progress: TransferProgress
  /** Absent while the transfer is still running: there is nothing to retry. */
  onRetry?: () => void
  /** Takes the finished row off the tray. */
  onDismiss: () => void
}

const BAR_CLASS = 'h-1 w-24 shrink-0 overflow-hidden rounded-full bg-[color:var(--overlay)]'

const CONTROL_CLASS = [
  'flex h-6 items-center gap-1 rounded-[var(--radius-sm)] px-1.5',
  'text-[color:var(--tx3)]',
  // Never disabled: a control that is on the tray is a control that can act.
  'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
  'focus-visible:bg-[color:var(--overlay)] focus-visible:text-[color:var(--tx)]',
].join(' ')

export const TransferProgressRow = ({
  onDismiss,
  onRetry,
  progress,
}: TransferProgressRowProps) => {
  const running = progress.status === 'queued' || progress.status === 'running'
  const pct = progress.total > 0
    ? Math.min(100, Math.round((progress.done / progress.total) * 100))
    : 0

  return (
    <span
      className="flex min-w-0 items-center gap-2"
      data-transfer-operation={progress.operation}
      data-transfer-row
      data-transfer-status={progress.status}
    >
      <span
        className={progress.status === 'failed'
          ? 'min-w-0 truncate text-[color:var(--danger-text)]'
          : 'min-w-0 truncate'}
      >
        {transferProgressSentence(progress)}
      </span>
      {running ? (
        <span
          aria-label={`${progress.done} of ${progress.total}`}
          className={BAR_CLASS}
          role="progressbar"
          aria-valuemax={progress.total}
          aria-valuemin={0}
          aria-valuenow={progress.done}
        >
          <span
            className="block h-full bg-[color:var(--accent)]"
            style={{ width: `${pct}%` }}
          />
        </span>
      ) : null}
      {!running && onRetry ? (
        <button className={CONTROL_CLASS} onClick={onRetry} type="button">
          <FontAwesomeIcon className="h-3 w-3" icon={faArrowRotateRight} />
          <span className="text-xs">Retry</span>
        </button>
      ) : null}
      {running ? null : (
        <button
          aria-label="Dismiss"
          className={CONTROL_CLASS}
          onClick={onDismiss}
          type="button"
        >
          <FontAwesomeIcon className="h-3 w-3" icon={faXmark} />
        </button>
      )}
    </span>
  )
}
