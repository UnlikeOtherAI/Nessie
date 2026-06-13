import { useState } from 'react'

type CommentComposerProps = {
  onSubmit: (body: string) => void
  pending?: boolean
  placeholder?: string
  submitLabel?: string
  autoFocus?: boolean
  initialValue?: string
  onCancel?: () => void
}

// Shared textarea + submit used for new comments, replies, and inline edits.
// Cmd/Ctrl+Enter submits.
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
  const submit = () => {
    const body = value.trim()
    if (!body) return
    onSubmit(body)
    if (!initialValue) setValue('')
  }

  return (
    <div className="flex flex-col gap-2">
      <textarea
        autoFocus={autoFocus}
        className="admin-input min-h-[64px] resize-y text-sm"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit()
        }}
        placeholder={placeholder ?? 'Add a comment…'}
        value={value}
      />
      <div className="flex items-center gap-2">
        <button
          className="admin-button admin-button-primary rounded-md px-3 py-1 text-xs"
          disabled={pending || !value.trim()}
          onClick={submit}
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
