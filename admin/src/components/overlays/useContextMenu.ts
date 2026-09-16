import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  HTMLAttributes,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react'

/**
 * Opening a context menu, on every input a person has.
 *
 * The three gestures that mean "what can I do with this" are a right-click, a
 * keyboard request (Shift+F10 or the dedicated ContextMenu key) and, on touch,
 * a long press. They differ only in what they anchor to, so the host spreads
 * one `triggerProps` on the surface and hands the resulting `anchor` to
 * {@link ContextMenu} — which composes `Popover`/`Sheet` and therefore owns
 * the layer, Back and Escape (docs/navigation/overview.md §7).
 */

export type ContextMenuAnchor =
  // The pointer. A zero-size rect, so the menu hangs off the exact point.
  | { kind: 'point'; x: number; y: number }
  // The focused row, for a menu the keyboard opened.
  | { kind: 'element'; ref: RefObject<HTMLElement | null> }

// A press this long, without moving this far, is a long press. 500 ms is the
// platform convention on both mobile engines; 8 px is the slop a finger
// resting on a scrolling list produces without meaning to move it.
export const LONG_PRESS_MS = 500
export const LONG_PRESS_SLOP_PX = 8

export type ContextMenuTrigger = {
  // null while closed.
  anchor: ContextMenuAnchor | null
  close: () => void
  // The pointer gesture: prevents the native menu and anchors at the point.
  openAt: (event: ReactMouseEvent | ReactPointerEvent) => void
  // The keyboard gesture: anchors under the element's own rect.
  openFor: (element: HTMLElement) => void
  // Spread on the trigger surface — the row, or the column's background.
  triggerProps: HTMLAttributes<HTMLElement>
}

type PendingPress = { timer: number; x: number; y: number }

// `event.target` is the row the person actually acted on; `currentTarget` is
// whatever element the handler was spread on, which for a column-level handler
// is the column. Duck-typed rather than `instanceof HTMLElement`, because the
// element belongs to the document the overlay host lives in and this module is
// also evaluated with no DOM global at all.
const eventElement = (event: {
  currentTarget: EventTarget & HTMLElement
  target: EventTarget | null
}): HTMLElement => {
  const target = event.target as HTMLElement | null
  return target && typeof target.getBoundingClientRect === 'function' ? target : event.currentTarget
}

export const useContextMenu = (): ContextMenuTrigger => {
  const [anchor, setAnchor] = useState<ContextMenuAnchor | null>(null)
  const press = useRef<PendingPress | null>(null)
  // A completed long press is followed by a `click` the browser synthesises
  // from the same finger. Without swallowing it once, the row both opens the
  // menu and opens itself.
  const swallowClick = useRef(false)

  const cancelPress = useCallback(() => {
    if (press.current) window.clearTimeout(press.current.timer)
    press.current = null
  }, [])

  useEffect(() => cancelPress, [cancelPress])

  const close = useCallback(() => {
    cancelPress()
    setAnchor(null)
  }, [cancelPress])

  const openAt = useCallback((event: ReactMouseEvent | ReactPointerEvent) => {
    event.preventDefault()
    // A row's menu must not also open the column background's: two hosts on
    // one surface are the normal shape, and React events bubble.
    event.stopPropagation()
    setAnchor({ kind: 'point', x: event.clientX, y: event.clientY })
  }, [])

  const openFor = useCallback((element: HTMLElement) => {
    setAnchor({ kind: 'element', ref: { current: element } })
  }, [])

  const triggerProps = useMemo<HTMLAttributes<HTMLElement>>(
    () => ({
      onClickCapture: (event) => {
        if (!swallowClick.current) return
        swallowClick.current = false
        event.preventDefault()
        event.stopPropagation()
      },
      onContextMenu: openAt,
      onKeyDown: (event) => {
        const wanted = event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')
        if (!wanted) return
        event.preventDefault()
        event.stopPropagation()
        openFor(eventElement(event))
      },
      onPointerCancel: cancelPress,
      onPointerDown: (event) => {
        if (event.pointerType !== 'touch') return
        cancelPress()
        const { clientX: x, clientY: y } = event
        const timer = window.setTimeout(() => {
          press.current = null
          swallowClick.current = true
          setAnchor({ kind: 'point', x, y })
        }, LONG_PRESS_MS)
        press.current = { timer, x, y }
      },
      onPointerMove: (event) => {
        const pending = press.current
        if (!pending) return
        // A scroll starts as a press that moves: the movement is what
        // cancels it, on every engine, before `pointercancel` may arrive.
        const moved = Math.hypot(event.clientX - pending.x, event.clientY - pending.y)
        if (moved > LONG_PRESS_SLOP_PX) cancelPress()
      },
      onPointerUp: cancelPress,
    }),
    [cancelPress, openAt, openFor],
  )

  return { anchor, close, openAt, openFor, triggerProps }
}
