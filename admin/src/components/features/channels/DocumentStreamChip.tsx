import {
  useDocumentStreamSnapshot,
  type DocumentStreamStore,
} from '../../../facades/threads/document-stream-store'
import {
  isDocumentStreamActive,
  type DocumentStreamEntry,
} from '../../../facades/threads/document-stream-helpers'

type DocumentStreamChipProps = {
  entry: DocumentStreamEntry
  onOpen: (sessionId: string) => void
  store: DocumentStreamStore
}

const statusLabel = (entry: DocumentStreamEntry, chars: number): string => {
  if (isDocumentStreamActive(entry)) {
    return `${chars.toLocaleString()} characters`
  }
  if (entry.status === 'saved') {
    return 'Saved'
  }
  if (entry.status === 'cancelled') {
    return 'Stopped'
  }
  return 'Not saved'
}

/**
 * The minimized document: a pill in the feed that says what is being written
 * and how far it has got, and puts the popup back. Minimizing never cancels —
 * the generation is untouched server-side — so this is also what a reader
 * returning to the conversation clicks.
 */
export const DocumentStreamChip = ({ entry, onOpen, store }: DocumentStreamChipProps) => {
  const live = useDocumentStreamSnapshot(store, entry)
  const streaming = isDocumentStreamActive(live)

  return (
    <div className="px-5 py-1">
      <button
        className={[
          'inline-flex max-w-full items-center gap-2 rounded-full border border-dashed',
          'border-[color:var(--sep)] bg-[var(--overlay-weak)] px-3 py-1',
          'text-xs text-[color:var(--tx2)] transition-colors',
          'hover:bg-[color:var(--main-hover)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
        ].join(' ')}
        data-testid="document-stream-chip"
        onClick={() => onOpen(live.sessionId)}
        type="button"
      >
        <span aria-hidden="true">📝</span>
        <span className="min-w-0 truncate font-semibold text-[var(--tx2)]">
          {live.title ?? 'Writing document…'}
        </span>
        <span className="flex-shrink-0 text-[color:var(--tx3)]">
          {statusLabel(live, live.markdown.length)}
        </span>
        {streaming ? (
          <span aria-hidden="true" className="thinking-dots">
            <span />
            <span />
            <span />
          </span>
        ) : null}
      </button>
    </div>
  )
}
