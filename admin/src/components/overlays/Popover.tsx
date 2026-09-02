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
import { useOverlay } from './useOverlay'
import {
  placePopover,
  viewportBounds,
  type PopoverAnchorRect,
  type PopoverBounds,
  type PopoverPlacement,
} from './placePopover'

/**
 * The admin's one anchored overlay (docs/navigation.md §7).
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

const readBounds = (): PopoverBounds => viewportBounds()

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
  const [placed, setPlaced] = useState<Placed | null>(null)

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
      bounds: readBounds(),
      panel: { height: rect.height, width: width ?? rect.width },
      placement,
    })
    const value: Placed = {
      left: next.left,
      maxHeight: next.maxHeight,
      top: next.top,
      width,
    }
    setPlaced((current) => (samePlacement(current, value) ? current : value))
  }, [anchorRect, anchorRef, matchAnchorWidth, panelRef, placement])

  useLayoutEffect(() => {
    if (!open) {
      setPlaced(null)
      return undefined
    }
    measure()
    window.addEventListener('resize', measure)
    // Capture, so a scroll inside any ancestor — a message feed, a settings
    // form — moves the panel with its anchor rather than leaving it behind.
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [measure, open])

  // Outside press. `mousedown`/`touchstart` rather than `click`, so a press
  // that starts outside dismisses before the release lands on something else.
  useEffect(() => {
    if (!open) return undefined
    const onPress = (event: Event) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
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
  )
}
