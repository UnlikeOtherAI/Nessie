import { useEffect } from 'react'

type Props = {
  limit: number
  onCancel: () => void
  onInsertTrimmed: (trimmed: string) => void
  open: boolean
  pastedText: string
}

/**
 * Shown when a paste would push the composer over the chat character limit.
 * The user can cancel the paste or insert the first `limit` characters.
 * A "send as attachment" path will land once the attachment subsystem exists.
 */
export const OversizePasteDialog = ({
  limit,
  onCancel,
  onInsertTrimmed,
  open,
  pastedText,
}: Props) => {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onCancel])

  if (!open) return null

  const handleOverlayClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onCancel()
    }
  }

  const preview = pastedText.length > 2000
    ? `${pastedText.slice(0, 2000)}\n\n…(${pastedText.length - 2000} more characters)`
    : pastedText

  return (
    <div
      onClick={handleOverlayClick}
      role="presentation"
      style={{
        alignItems: 'center',
        backdropFilter: 'blur(4px)',
        background: 'rgba(0, 0, 0, 0.6)',
        display: 'flex',
        inset: 0,
        justifyContent: 'center',
        position: 'fixed',
        zIndex: 9999,
      }}
    >
      <div
        className="create-channel-panel"
        style={{ maxWidth: 640, width: '100%' }}
      >
        <div className="create-channel-header">
          <h2 className="text-lg font-bold text-white">
            That&apos;s too long for chat
          </h2>
          <button
            className={[
              'flex h-7 w-7 items-center justify-center',
              'rounded text-[color:var(--tx3)]',
              'hover:bg-white/10 hover:text-white',
            ].join(' ')}
            onClick={onCancel}
            type="button"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path
                d="M6 18L18 6M6 6l12 12"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <div className="grid gap-4">
          <p className="text-sm text-[color:var(--tx2)]">
            You pasted {pastedText.length.toLocaleString()} characters.
            The chat limit is {limit.toLocaleString()}. Long documents
            don&apos;t read well inline and blow up the model&apos;s
            context. Send it as a file instead, or insert a trimmed
            version.
          </p>

          <div
            className={[
              'max-h-[260px] overflow-auto rounded-md',
              'border border-[color:var(--sep)] bg-black/30',
              'p-3 font-mono text-xs text-[color:var(--tx2)]',
              'whitespace-pre-wrap break-words',
            ].join(' ')}
          >
            {preview}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              className="admin-button admin-button-secondary"
              onClick={onCancel}
              type="button"
            >
              Cancel
            </button>
            <button
              className="admin-button admin-button-secondary"
              onClick={() => onInsertTrimmed(pastedText.slice(0, limit))}
              type="button"
            >
              Insert first {limit.toLocaleString()} chars
            </button>
            <button
              className="admin-button admin-button-primary opacity-50"
              disabled
              title="Attachment upload is not wired up yet"
              type="button"
            >
              Send as file (soon)
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
