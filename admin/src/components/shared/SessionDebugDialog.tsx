import { useId, useRef, type FormEvent } from 'react'
import { OverlayPortal } from '../overlays/OverlayPortal'
import { useOverlay } from '../overlays/useOverlay'
import { Notice } from '../primitives/Notice'

export const SessionDebugIcon = () => (
  <svg
    aria-hidden="true"
    fill="none"
    height="20"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2"
    viewBox="0 0 24 24"
    width="20"
  >
    <path d="m8 2 1.88 1.88" />
    <path d="M14.12 3.88 16 2" />
    <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
    <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
    <path d="M12 20v-9" />
    <path d="M6.53 9C4.6 8.8 3 7.1 3 5" />
    <path d="M6 13H2" />
    <path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
    <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" />
    <path d="M22 13h-4" />
    <path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />
  </svg>
)

type SessionDebugDialogProps = {
  actionDisabled?: boolean
  actionLabel: string
  description: string
  error?: string | null
  onAction: () => void
  onChange?: (value: string) => void
  onClose: () => void
  open: boolean
  pending?: boolean
  pendingLabel?: string
  readOnly?: boolean
  selectOnFocus?: boolean
  textareaLabel: string
  title: string
  value: string
}

export const SessionDebugDialog = ({
  actionDisabled = false,
  actionLabel,
  description,
  error = null,
  onAction,
  onChange,
  onClose,
  open,
  pending = false,
  pendingLabel,
  readOnly = false,
  selectOnFocus = false,
  textareaLabel,
  title,
  value,
}: SessionDebugDialogProps) => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  const overlay = useOverlay({
    dismissDisabled: pending,
    id: titleId,
    initialFocusRef: textareaRef,
    kind: 'modal',
    label: `Close ${title}`,
    onClose,
    open,
  })

  if (!overlay.mounted) return null

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!actionDisabled && !pending) onAction()
  }

  return (
    <OverlayPortal>
      {/* Not the shared `Dialog`: this one is tuned for phones — safe-area insets on
          the scrim, a 44px close target instead of the shell's 28px, and a dvh
          max-height with a scrolling flex column. `useOverlay` still gives it the
          Back registration, focus trap, drag-safe scrim and layer every other
          overlay gets (docs/navigation/overview.md §7). */}
      <div
        {...overlay.scrimProps}
        className="fixed inset-0 flex items-center justify-center bg-[var(--scrim-strong)] backdrop-blur-sm"
        style={{
          ...overlay.layerStyle,
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          paddingLeft: 'env(safe-area-inset-left, 0px)',
          paddingRight: 'env(safe-area-inset-right, 0px)',
          paddingTop: 'env(safe-area-inset-top, 0px)',
        }}
      >
        <div
          aria-busy={pending || undefined}
          aria-describedby={descriptionId}
          aria-labelledby={titleId}
          aria-modal="true"
          className="create-channel-panel flex flex-col overflow-hidden"
          ref={overlay.panelRef}
          role="dialog"
          style={{
            maxHeight: [
              'calc(100dvh - env(safe-area-inset-top, 0px)',
              '- env(safe-area-inset-bottom, 0px) - 2rem)',
            ].join(' '),
            maxWidth: 640,
          }}
          tabIndex={-1}
        >
          <div className="create-channel-header flex-shrink-0">
            <div>
              <h2
                className="text-lg font-bold text-[color:var(--tx)]"
                id={titleId}
              >
                {title}
              </h2>
              <div
                className="text-xs text-[color:var(--tx3)]"
                id={descriptionId}
              >
                {description}
              </div>
            </div>
            <button
              aria-label={`Close ${title.toLowerCase()}`}
              className={[
                'flex h-11 w-11 flex-shrink-0 items-center justify-center',
                'rounded text-[color:var(--tx3)]',
                'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
              ].join(' ')}
              disabled={pending}
              onClick={onClose}
              type="button"
            >
              <svg
                aria-hidden="true"
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

          <form
            className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
            onSubmit={handleSubmit}
          >
            <textarea
              aria-label={textareaLabel}
              autoCapitalize="off"
              autoCorrect="off"
              className="admin-input admin-input-mono min-h-40 flex-1"
              onChange={onChange ? (event) => onChange(event.target.value) : undefined}
              onFocus={selectOnFocus ? (event) => event.currentTarget.select() : undefined}
              readOnly={readOnly}
              ref={textareaRef}
              rows={16}
              spellCheck={false}
              style={{ resize: 'vertical', whiteSpace: 'pre', overflowWrap: 'normal' }}
              value={value}
            />

            {error ? (
              <Notice className="mt-3" radius="xl" role="alert" tone="danger">
                {error}
              </Notice>
            ) : null}

            <span aria-live="polite" className="sr-only">
              {pending ? pendingLabel ?? actionLabel : ''}
            </span>

            <div className="flex flex-shrink-0 justify-end gap-2 pt-4">
              <button
                className="admin-button admin-button-secondary disabled:cursor-not-allowed disabled:opacity-50"
                disabled={pending}
                onClick={onClose}
                type="button"
              >
                Cancel
              </button>
              <button
                className="admin-button admin-button-primary disabled:cursor-not-allowed disabled:opacity-50"
                disabled={actionDisabled || pending}
                type="submit"
              >
                {pending ? pendingLabel ?? actionLabel : actionLabel}
              </button>
            </div>
          </form>
        </div>
      </div>
    </OverlayPortal>
  )
}
