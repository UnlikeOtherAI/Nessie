import { useEffect, useState } from 'react'
import { useOverlayDismiss } from './useOverlayDismiss'

type Props = {
  limit: number
  onCancel: () => void
  onInsertTrimmed: (trimmed: string) => void
  // Upload the pasted text as a `.txt` attachment and send it with the message.
  // Returns once the upload + send has completed (or rejects on failure).
  onSendAsFile?: (text: string) => Promise<void>
  open: boolean
  pastedText: string
}

/**
 * Shown when a paste would push the composer over the chat character limit.
 * The user can cancel the paste, insert the first `limit` characters, or send
 * the whole paste as a `.txt` attachment via `onSendAsFile`.
 */
export const OversizePasteDialog = ({
  limit,
  onCancel,
  onInsertTrimmed,
  onSendAsFile,
  open,
  pastedText,
}: Props) => {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
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

  const overlayDismiss = useOverlayDismiss(onCancel)

  if (!open) return null

  const preview = pastedText.length > 2000
    ? `${pastedText.slice(0, 2000)}\n\n…(${pastedText.length - 2000} more characters)`
    : pastedText

  return (
    <div
      {...overlayDismiss}
      style={{
        alignItems: 'center',
        backdropFilter: 'blur(4px)',
        background: 'var(--scrim-strong)',
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
          <h2 className="text-lg font-bold text-[color:var(--tx)]">
            That&apos;s too long for chat
          </h2>
          <button
            className={[
              'flex h-7 w-7 items-center justify-center',
              'rounded text-[color:var(--tx3)]',
              'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
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
              'border border-[color:var(--sep)] bg-[color:var(--scrim)]',
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
              className="admin-button admin-button-primary"
              disabled={!onSendAsFile || sending}
              onClick={() => {
                if (!onSendAsFile) return
                setError(null)
                setSending(true)
                onSendAsFile(pastedText)
                  .catch((err: unknown) =>
                    setError(err instanceof Error ? err.message : 'Upload failed'),
                  )
                  .finally(() => setSending(false))
              }}
              type="button"
            >
              {sending ? 'Sending…' : 'Send as file'}
            </button>
          </div>
          {error ? (
            <p className="text-sm text-[color:var(--danger-text)]">{error}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
