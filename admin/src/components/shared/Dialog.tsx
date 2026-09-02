import {
  useId,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { useOverlay } from '../overlays/useOverlay'

/**
 * The admin's one centred modal shell.
 *
 * Every centred dialog in the admin was hand-assembling the same three things —
 * a fixed `--scrim-strong` scrim, a `.create-channel-panel` card, and a
 * `.create-channel-header` row ending in the same 24-viewBox close cross — and
 * roughly half of them shipped with no keyboard or screen-reader affordances at
 * all: no Escape, no focus trap, no focus restore, no `role="dialog"`. This
 * composes {@link useOverlay} unconditionally — Back registration, Escape,
 * focus trap and restore, the drag-safe scrim, the modal layer and the open /
 * close motion — so a dialog cannot be built without them
 * (docs/navigation.md §7).
 *
 * `size` names the four panel geometries the admin actually ships. It is not a
 * general scale: a dialog whose panel is none of these keeps its own markup
 * rather than growing another token here.
 */

type DialogSize = 'md' | 'lg' | 'xl' | 'full'

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
  // A table needs to stay within a small viewport gutter while preserving its
  // columns, not inherit the constrained editor geometry of ordinary dialogs.
  full: {
    display: 'flex',
    flexDirection: 'column',
    height: 'calc(100dvh - 2rem)',
    maxHeight: 'none',
    maxWidth: 'none',
    minHeight: 0,
    overflow: 'hidden',
    width: 'calc(100vw - 2rem)',
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
}

const closeButtonClass = [
  'flex h-7 w-7 items-center justify-center',
  'rounded text-[color:var(--tx3)]',
  'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
].join(' ')

type DialogProps = {
  children: ReactNode
  /**
   * The one sanctioned nesting: a confirm over an open modal renders in the
   * blocking layer and outranks the modal beneath it for Back. Everything
   * else is a plain modal, and a second modal is a Flow step, not a stack.
   */
  blocking?: boolean
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
  blocking = false,
  children,
  description,
  dismissDisabled = false,
  initialFocusRef,
  onClose,
  open,
  size = 'md',
  title,
}: DialogProps) => {
  const titleId = useId()
  const descriptionId = useId()
  const overlay = useOverlay({
    dismissDisabled,
    id: titleId,
    initialFocusRef,
    kind: blocking ? 'blocking' : 'modal',
    label: `Close ${title}`,
    onClose,
    open,
  })
  const { requestClose } = overlay

  if (!overlay.mounted) return null

  return (
    <div
      {...overlay.scrimProps}
      style={{
        ...SCRIM_STYLE,
        ...overlay.layerStyle,
        ...(overlay.closing ? { pointerEvents: 'none' } : undefined),
      }}
    >
      <div
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className="create-channel-panel"
        ref={overlay.panelRef}
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
