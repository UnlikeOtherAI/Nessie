import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { OverlayPortal } from './OverlayPortal'
import { useOverlay } from './useOverlay'
import { placePopover, viewportBounds } from './placePopover'
import type { PopoverAnchorRect, PopoverPlacement } from './placePopover'

/**
 * The admin's one anchored overlay (docs/navigation/overview.md §7).
 *
 * Every menu, picker and suggestion list in the admin was hand-assembling the
 * same four things — a fixed panel, a `z-[6x]` of its own, an outside-press
 * listener and (in five of them) a private flip/clamp routine. This composes
 * {@link useOverlay}, so a popover cannot ship without Escape, without the
 * shared open/close motion, or without closing before a route change slides;
 * and it places itself through the one {@link placePopover} helper, so it
 * cannot ship without a flip.
 *
 * It deliberately does **not** trap focus: `useOverlay` gives a popover Escape
 * alone, because a menu that steals focus from the trigger it hangs off is a
 * dialog wearing a menu's clothes.
 */

export type PopoverRole = 'menu' | 'listbox' | 'dialog' | 'tooltip'

type PopoverProps = {
  /**
   * The trigger. Its rect is the anchor, and a press on it is not an outside
   * press — the trigger owns the toggle, so the popover must not close first
   * and let the trigger re-open it.
   */
  anchorRef: RefObject<HTMLElement | null>
  /**
   * A rect to anchor to instead of the trigger's own — the text caret an
   * editor suggestion list hangs off. The trigger still governs outside press.
   */
  anchorRect?: PopoverAnchorRect | null
  children: ReactNode
  className?: string
  id?: string
  /** The accessible name; also what the Back control announces on `single`. */
  label: string
  /** Sizes the panel to its anchor, the way a combobox listbox matches its input. */
  matchAnchorWidth?: boolean
  onClose: () => void
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  open: boolean
  placement?: PopoverPlacement
  role?: PopoverRole
  style?: CSSProperties
}

type Placed = {
  left: number
  maxHeight: number
  top: number
  width: number | null
}

const samePlacement = (a: Placed | null, b: Placed): boolean =>
  a !== null
  && a.left === b.left
  && a.top === b.top
  && a.maxHeight === b.maxHeight
  && a.width === b.width

export const Popover = ({
  anchorRef,
  anchorRect = null,
  children,
  className,
  id,
  label,
  matchAnchorWidth = false,
  onClose,
  onKeyDown,
  open,
  placement = 'bottom-start',
  role = 'dialog',
  style,
}: PopoverProps) => {
  const generatedId = useId()
  const overlay = useOverlay({
    id: id ?? generatedId,
    kind: 'popover',
    label,
    onClose,
    open,
  })
  const { panelRef, requestClose } = overlay
  const [rectPlaced, setRectPlaced] = useState<Placed | null>(null)

  const measure = useCallback(() => {
    const panel = panelRef.current
    if (!panel) return
    const anchorElement = anchorRef.current
    const anchor = anchorRect ?? anchorElement?.getBoundingClientRect() ?? null
    if (!anchor) return
    const rect = panel.getBoundingClientRect()
    const width = matchAnchorWidth && anchorElement
      ? anchorElement.getBoundingClientRect().width
      : null
    const next = placePopover({
      anchor,
      bounds: viewportBounds(),
      panel: { height: rect.height, width: width ?? rect.width },
      placement,
    })
    const value: Placed = {
      left: next.left,
      maxHeight: next.maxHeight,
      top: next.top,
      width,
    }
    setRectPlaced((current) => (samePlacement(current, value) ? current : value))
  }, [anchorRect, anchorRef, matchAnchorWidth, panelRef, placement])

  // Measure every anchor through the same viewport geometry. The panel leaves
  // the page tree for the overlay host, so an overflow ancestor of the trigger
  // cannot be its clipping box: it is precisely what the portal escaped. This
  // also makes the first open deterministic — the layout effect measures before
  // the hidden panel is first painted, instead of waiting for a later resize.
  useLayoutEffect(() => {
    if (!open) {
      setRectPlaced(null)
      return undefined
    }
    measure()
    window.addEventListener('resize', measure)
    // Capture, so a scroll inside any ancestor — a message feed, a settings
    // form — moves the panel with its anchor rather than leaving it behind.
    window.addEventListener('scroll', measure, true)

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        window.removeEventListener('resize', measure)
        window.removeEventListener('scroll', measure, true)
      }
    }
    const observer = new ResizeObserver(measure)
    const panel = panelRef.current
    const anchor = anchorRef.current
    if (panel) observer.observe(panel)
    if (anchor) observer.observe(anchor)
    // The viewport changes when the document's layout changes even in engines
    // that do not report an element-level resize for the anchor.
    observer.observe(document.body)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
      observer.disconnect()
    }
  }, [anchorRef, measure, open, panelRef])

  const placed = rectPlaced

  // Outside press. `mousedown`/`touchstart` rather than `click`, so a press
  // that starts outside dismisses before the release lands on something else.
  useEffect(() => {
    if (!open) return undefined
    const onPress = (event: Event) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      // A modal or another popover can be portalled above this one. It is not
      // an "outside" press for the lower layer: closing this menu would
      // unmount the control that owns the higher overlay before its button's
      // click fires (the session-debug Copy action was the visible failure).
      // Direct children of the shared host are independent overlay trees.
      const panel = panelRef.current
      const host = panel?.parentElement
      if (host?.classList.contains('admin-overlay-root')) {
        let overlayTree = target instanceof Element ? target : target.parentElement
        while (overlayTree && overlayTree.parentElement !== host) {
          overlayTree = overlayTree.parentElement
        }
        if (overlayTree && overlayTree !== panel) return
      }
      requestClose()
    }
    document.addEventListener('mousedown', onPress)
    document.addEventListener('touchstart', onPress)
    return () => {
      document.removeEventListener('mousedown', onPress)
      document.removeEventListener('touchstart', onPress)
    }
  }, [anchorRef, open, panelRef, requestClose])

  if (!overlay.mounted) return null

  return (
    <OverlayPortal>
      <div
        aria-label={label}
        className={className}
        id={id}
        onKeyDown={onKeyDown}
        ref={panelRef}
        role={role}
        style={{
          position: 'fixed',
          ...overlay.layerStyle,
          // Until the first measurement the panel is laid out but not painted:
          // it has to be in the DOM at its natural size to be measured at all.
          ...(placed
            ? { left: placed.left, maxHeight: placed.maxHeight, top: placed.top }
            : { left: 0, top: 0, visibility: 'hidden' as const }),
          ...(placed?.width === null || placed?.width === undefined
            ? undefined
            : { width: placed.width }),
          ...(overlay.closing ? { pointerEvents: 'none' as const } : undefined),
          ...style,
        }}
      >
        {children}
      </div>
    </OverlayPortal>
  )
}
