import { useState } from 'react'

type CommentComposerProps = {
  // May return a promise; the composer clears/keeps text based on its outcome.
  onSubmit: (body: string) => void | Promise<unknown>
  pending?: boolean
  placeholder?: string
  submitLabel?: string
  autoFocus?: boolean
  initialValue?: string
  onCancel?: () => void
}

// Shared textarea + submit used for new comments, replies, and inline edits.
// Cmd/Ctrl+Enter submits. The typed text is only cleared once the submit
// resolves, and a failure surfaces inline instead of silently dropping input.
export const CommentComposer = ({
  onSubmit,
  pending,
  placeholder,
  submitLabel = 'Comment',
  autoFocus,
  initialValue = '',
  onCancel,
}: CommentComposerProps) => {
  const [value, setValue] = useState(initialValue)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const body = value.trim()
    if (!body || busy) return
    setError(null)
    setBusy(true)
    try {
      await onSubmit(body)
      // Keep edit drafts (initialValue set); clear the new-comment/reply box.
      if (!initialValue) setValue('')
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not save — please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <textarea
        autoFocus={autoFocus}
        className="admin-input min-h-[64px] resize-y text-sm"
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit()
        }}
        placeholder={placeholder ?? 'Add a comment…'}
        value={value}
      />
      {error ? <p className="text-xs text-[var(--danger-text)]">{error}</p> : null}
      <div className="flex items-center gap-2">
        <button
          className="admin-button admin-button-primary rounded-md px-3 py-1 text-xs"
          disabled={busy || pending || !value.trim()}
          onClick={() => void submit()}
          type="button"
        >
          {submitLabel}
        </button>
        {onCancel ? (
          <button
            className="admin-button admin-button-secondary rounded-md px-3 py-1 text-xs"
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  )
}
