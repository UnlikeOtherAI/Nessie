import {
  useCallback,
  useId,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { useModalA11y } from './useModalA11y'
import { useOverlayDismiss } from './useOverlayDismiss'

/**
 * The admin's one centred modal shell.
 *
 * Every centred dialog in the admin was hand-assembling the same three things —
 * a fixed `--scrim-strong` scrim, a `.create-channel-panel` card, and a
 * `.create-channel-header` row ending in the same 24-viewBox close cross — and
 * roughly half of them shipped with no keyboard or screen-reader affordances at
 * all: no Escape, no focus trap, no focus restore, no `role="dialog"`. This
 * composes {@link useModalA11y} and {@link useOverlayDismiss} unconditionally,
 * so a dialog cannot be built without them.
 *
 * `size` names the three panel geometries the admin actually ships. It is not a
 * general scale: a dialog whose panel is none of these keeps its own markup
 * rather than growing a fourth token here.
 */

type DialogSize = 'md' | 'lg' | 'xl'

// `md` is the `.create-channel-panel` default (440px, 16px gutter). The other
// two are the exact inline overrides their call sites already carried.
const PANEL_STYLE: Record<DialogSize, CSSProperties | undefined> = {
  md: undefined,
  lg: { maxWidth: 640, width: '100%' },
  xl: {
    maxHeight: '88vh',
    maxWidth: 'none',
    overflowY: 'auto',
    width: 'min(80vw, 1100px)',
  },
}

const SCRIM_STYLE: CSSProperties = {
  alignItems: 'center',
  backdropFilter: 'blur(4px)',
  background: 'var(--scrim-strong)',
  display: 'flex',
  inset: 0,
  justifyContent: 'center',
  position: 'fixed',
  zIndex: 9999,
}

const closeButtonClass = [
  'flex h-7 w-7 items-center justify-center',
  'rounded text-[color:var(--tx3)]',
  'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
].join(' ')

type DialogProps = {
  children: ReactNode
  /**
   * Refuses every close path the shell owns — scrim, Escape, and the close
   * cross — while a submit is in flight. The cross keeps its enabled styling
   * and tab stop, exactly as the pending-gated call sites rendered it; only the
   * action is withheld.
   */
  dismissDisabled?: boolean
  description?: ReactNode
  /** Focused on open; without one, focus lands on the first focusable child. */
  initialFocusRef?: RefObject<HTMLElement | null>
  onClose: () => void
  open: boolean
  size?: DialogSize
  title: string
}

export const Dialog = ({
  children,
  description,
  dismissDisabled = false,
  initialFocusRef,
  onClose,
  open,
  size = 'md',
  title,
}: DialogProps) => {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()

  // `useModalA11y` re-runs its whole effect when `onClose` changes identity —
  // re-focusing the initial control and restoring focus on cleanup. Call sites
  // rebuild their close handler on every keystroke, so the callback handed to
  // the hook has to be stable or typing would yank focus back to the first
  // field. These refs carry the live handler and the live dismiss gate without
  // making that callback depend on either.
  //
  // Synced during render rather than in a passive effect: an effect leaves a
  // window between the commit that flips `dismissDisabled` and the sync, and a
  // close gesture landing in it would read the stale value and discard an
  // in-flight submit.
  const onCloseRef = useRef(onClose)
  const dismissDisabledRef = useRef(dismissDisabled)
  onCloseRef.current = onClose
  dismissDisabledRef.current = dismissDisabled

  const requestClose = useCallback(() => {
    if (dismissDisabledRef.current) return
    onCloseRef.current()
  }, [])

  useModalA11y(panelRef, requestClose, open, initialFocusRef)
  const overlayDismiss = useOverlayDismiss(requestClose)

  if (!open) return null

  return (
    <div {...overlayDismiss} style={SCRIM_STYLE}>
      <div
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className="create-channel-panel"
        ref={panelRef}
        role="dialog"
        style={PANEL_STYLE[size]}
        tabIndex={-1}
      >
        <div className="create-channel-header">
          <div>
            <h2 className="text-lg font-bold text-[color:var(--tx)]" id={titleId}>
              {title}
            </h2>
            {description ? (
              <div className="text-xs text-[color:var(--tx3)]" id={descriptionId}>
                {description}
              </div>
            ) : null}
          </div>
          <button
            aria-label="Close"
            className={closeButtonClass}
            onClick={requestClose}
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
              <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {children}
      </div>
    </div>
  )
}
