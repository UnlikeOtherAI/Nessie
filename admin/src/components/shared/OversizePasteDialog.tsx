import { useState } from 'react'
import { Dialog } from './Dialog'

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

  if (!open) return null

  const preview = pastedText.length > 2000
    ? `${pastedText.slice(0, 2000)}\n\n…(${pastedText.length - 2000} more characters)`
    : pastedText

  return (
    <Dialog
      onClose={onCancel}
      open={open}
      size="lg"
      title={"That's too long for chat"}
    >
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
    </Dialog>
  )
}
