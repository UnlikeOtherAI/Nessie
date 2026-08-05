import { faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { formatBytes } from '../../../lib/upload-xhr'
import type { ComposerAttachments as ComposerAttachmentsState } from './useComposerAttachments'

// Strip of files staged for the next message: name, size, live upload
// progress, failure state, and a remove control. Rendered inside the composer
// above the toolbar; collapses to nothing when nothing is staged.
export const ComposerAttachments = ({
  attachments,
}: {
  attachments: ComposerAttachmentsState
}) => {
  if (attachments.staged.length === 0 && !attachments.error) {
    return null
  }

  return (
    <div
      className="flex flex-col gap-1.5 border-b border-[color:var(--border-strong)] px-3 py-2"
      data-testid="composer-attachments"
    >
      {attachments.staged.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {attachments.staged.map((entry) => (
            <li
              className={[
                'flex min-w-[10rem] max-w-full flex-col gap-1 rounded-lg border px-2.5 py-1.5',
                entry.status === 'error'
                  ? 'border-[color:var(--danger-text)]'
                  : 'border-[color:var(--sep)]',
                'bg-[color:var(--overlay-weak)]',
              ].join(' ')}
              data-testid="composer-attachment-chip"
              key={entry.clientId}
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-xs text-[color:var(--tx)]" title={entry.filename}>
                  {entry.filename}
                </span>
                <span className="ml-auto text-[11px] text-[color:var(--tx3)]">
                  {entry.status === 'uploading'
                    ? `${entry.pct}%`
                    : formatBytes(entry.sizeBytes)}
                </span>
                <button
                  aria-label={`Remove ${entry.filename}`}
                  className="flex h-4 w-4 items-center justify-center rounded text-[color:var(--tx3)] hover:bg-[var(--overlay)] hover:text-[color:var(--tx)]"
                  onClick={() => attachments.removeStaged(entry.clientId)}
                  title="Remove"
                  type="button"
                >
                  <FontAwesomeIcon className="h-3 w-3" icon={faXmark} />
                </button>
              </div>
              {entry.status === 'uploading' ? (
                <div className="h-1 w-full overflow-hidden rounded-full bg-[color:var(--overlay)]">
                  <div
                    className="h-full rounded-full bg-[color:var(--accent)] transition-[width] duration-150"
                    style={{ width: `${entry.pct}%` }}
                  />
                </div>
              ) : null}
              {entry.status === 'error' ? (
                <span className="text-[11px] text-[color:var(--danger-text)]" role="alert">
                  {entry.error ?? 'Upload failed'}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {attachments.error ? (
        <span className="text-xs text-[color:var(--danger-text)]" role="alert">
          {attachments.error}
        </span>
      ) : null}
    </div>
  )
}
