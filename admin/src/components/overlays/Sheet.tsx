import { haptic } from '../../lib/haptics'
import {
  useCallback,
  useId,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  type TouchEvent as ReactTouchEvent,
} from 'react'
import { useNavigationLayout } from '../../lib/mobile-shell'
import type { SheetSide } from '../../navigation/overlay'
import { isPhoneBackSwipeClaimableTarget } from '../../layouts/admin-shell/phone-navigation-gesture'
import {
  isSheetSwipeAligned,
  resolveSheetSwipeOutcome,
  type PhoneBackSwipeSample,
} from './sheet-swipe'
import { useOverlay } from './useOverlay'

/**
 * The admin's one edge-anchored overlay shell (docs/navigation/overview.md §7).
 *
 * Eight drawers each hand-rolled the same three things — a fixed scrim, a
 * literal stacking pair, and a `transition-transform` slide — and none of
 * them had Escape, a focus trap, focus restore, a `role="dialog"` or a Back
 * registration. This composes {@link useOverlay} unconditionally, so a drawer
 * cannot be built without them, and the slide comes from the shared overlay
 * transition on `OVERLAY_MOTION.drawerMs`; the Sheet declares no transition or
 * animation of its own.
 *
 * The shell is structure only — position, layer, size, motion, a11y and the
 * swipe. Each drawer keeps its own surface (background, border, radius,
 * shadow) on its content root, because the eight do not agree on one and a
 * shared surface would have to be undone by half of them.
 *
 * `size` names the four panel geometries the drawers actually ship. It is not
 * a general scale: a sheet whose panel is none of these belongs in this record
 * with its own name, never in a call-site override.
 */

type SheetSize = 'auto' | 'sm' | 'md' | 'lg'

const ANCHOR_STYLE: Record<SheetSide, CSSProperties> = {
  bottom: { bottom: 0, left: 0, right: 0 },
  left: { bottom: 0, left: 0, top: 0 },
  right: { bottom: 0, right: 0, top: 0 },
}

// `auto` is the nav drawer, whose child carries its own width; the other three
// are the exact widths their call sites already declared, and `lg` is the agent
// quick view's floating inset card. Exported so the shipped set is pinned
// directly — the single layout covers the widths on a server render.
export const SHEET_SIZE_STYLE: Record<SheetSize, CSSProperties> = {
  auto: { maxWidth: '85vw' },
  lg: {
    borderRadius: '1rem',
    bottom: '0.75rem',
    right: '0.75rem',
    top: '0.75rem',
    width: 'min(620px, calc(100vw - 1.5rem))',
  },
  md: { width: 'min(430px, 100vw)' },
  sm: { width: 'min(360px, 100vw)' },
}

// The one allowed layout branch (docs/navigation/overview.md §5): on a single-column
// layout a side sheet covers the screen rather than leaving a scrim strip too
// narrow to aim at. `auto` opts out — its child is a navigation column that is
// deliberately narrower than the viewport so the scrim stays tappable.
const FULL_BLEED_STYLE: CSSProperties = {
  borderRadius: 0,
  bottom: 0,
  left: 0,
  maxWidth: '100%',
  right: 0,
  top: 0,
  width: '100%',
}

const SCRIM_STYLE: CSSProperties = {
  background: 'var(--scrim)',
  inset: 0,
  position: 'fixed',
}

const PANEL_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  position: 'fixed',
}

type SheetProps = {
  children: ReactNode
  /** Refuses every close path the shell owns while a submit is in flight. */
  dismissDisabled?: boolean
  /** Focused on open; without one, focus lands on the first focusable child. */
  initialFocusRef?: RefObject<HTMLElement | null>
  onClose: () => void
  open: boolean
  side: SheetSide
  size?: SheetSize
  /** The sheet's accessible name. Drawers render their own visible headers. */
  title: string
}

// The finger is followed only as a decision, never as a transform: the panel's
// pose belongs to the shared overlay transition, and a second writer would
// fight its fill. A drag past the shared commit ratio closes; anything else
// leaves the sheet exactly where it was, which is the snap-back.
const useSheetSwipe = (
  side: SheetSide,
  panelRef: RefObject<HTMLDivElement | null>,
  requestClose: () => void,
) => {
  const samples = useRef<PhoneBackSwipeSample[] | null>(null)
  const claimed = useRef(false)

  const reset = useCallback(() => {
    samples.current = null
    claimed.current = false
  }, [])

  const sample = (touch: { clientX: number; clientY: number }): PhoneBackSwipeSample => ({
    clientX: touch.clientX,
    clientY: touch.clientY,
    time: Date.now(),
  })

  const onTouchStart = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      reset()
      const touch = event.touches.length === 1 ? event.touches[0] : undefined
      if (!touch || !isPhoneBackSwipeClaimableTarget(event.target)) return
      samples.current = [sample(touch)]
    },
    [reset],
  )

  const onTouchMove = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      const started = samples.current
      const touch = event.touches.length === 1 ? event.touches[0] : undefined
      if (!started || !touch) return
      const first = started[0]
      if (!first) return
      started.push(sample(touch))
      if (claimed.current) return
      claimed.current = isSheetSwipeAligned(
        side,
        touch.clientX - first.clientX,
        touch.clientY - first.clientY,
      )
    },
    [side],
  )

  const onTouchEnd = useCallback(() => {
    const collected = samples.current
    const panel = panelRef.current
    const wasClaimed = claimed.current
    reset()
    if (!collected || !wasClaimed || !panel) return
    const extentPx = side === 'bottom' ? panel.offsetHeight : panel.offsetWidth
    if (resolveSheetSwipeOutcome({ extentPx, samples: collected, side }) === 'commit') {
      // A committed sheet swipe feels like a committed edge swipe (§10).
      haptic('light')
      requestClose()
    }
  }, [panelRef, requestClose, reset, side])

  return { onTouchCancel: reset, onTouchEnd, onTouchMove, onTouchStart }
}

export const Sheet = ({
  children,
  dismissDisabled = false,
  initialFocusRef,
  onClose,
  open,
  side,
  size = 'auto',
  title,
}: SheetProps) => {
  const titleId = useId()
  const layout = useNavigationLayout()
  const overlay = useOverlay({
    dismissDisabled,
    id: titleId,
    initialFocusRef,
    kind: 'sheet',
    label: `Close ${title}`,
    onClose,
    open,
    side,
  })
  const swipe = useSheetSwipe(side, overlay.panelRef, overlay.requestClose)

  if (!overlay.mounted) return null

  const fullBleed = layout === 'single' && side !== 'bottom' && size !== 'auto'
  const inert = overlay.closing ? { pointerEvents: 'none' as const } : undefined

  return (
    <div
      {...overlay.scrimProps}
      style={{ ...SCRIM_STYLE, ...overlay.layerStyle, ...inert }}
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        ref={overlay.panelRef}
        role="dialog"
        style={{
          ...PANEL_STYLE,
          ...ANCHOR_STYLE[side],
          ...(side === 'bottom' ? undefined : SHEET_SIZE_STYLE[size]),
          ...(fullBleed ? FULL_BLEED_STYLE : undefined),
          ...inert,
        }}
        tabIndex={-1}
        {...swipe}
      >
        <h2 className="sr-only" id={titleId}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  )
}
