import { useLayoutEffect, useState, type RefObject } from 'react'
import {
  placePopoverInRect,
  type ClampedPopoverPlacement,
  type PopoverPlacement,
  type PopoverRect,
} from './popover-placement'

// The measured half of D11 (docs/plans/2026-08-13-responsive-coherence.md):
// popovers used to clamp against `window.innerWidth` read once at open, which
// mis-places them inside the resizable shell — the real clipping box is a
// scrolling/overflow-clipped ancestor, narrower than the window — and never
// recomputes when the sidebar or thread panel reflows the anchor. This hook
// resolves that clipping ancestor, observes it and the anchor with ONE
// ResizeObserver (no window-resize listener: ancestor-driven recompute is what
// a window resize amounts to for a fixed-position panel), and returns the
// clamped placement from the pure placePopoverInRect.

export type PopoverAnchorInput =
  | { kind: 'element'; element: HTMLElement }
  | { kind: 'rect'; rect: PopoverRect }

// The box the panel may occupy when nothing clips it. Panel positioning is
// geometry, not classification (the eslint.config.js admission for this
// module): the window is simply the outermost clipping box.
const windowClip = (): PopoverRect => ({
  bottom: window.innerHeight,
  left: 0,
  right: window.innerWidth,
  top: 0,
})

// Fixed-position panels escape every ancestor transform except one — an
// element whose computed transform/filter/perspective is not `none` becomes
// the containing block for fixed descendants (a `will-change: transform` shell
// is the common case). The panel then has to clamp against that box: inside
// it, fixed coordinates are relative to it.
const fixedContainingBlock = (panel: HTMLElement): HTMLElement | null => {
  let node = panel.parentElement
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node)
    if (style.transform !== 'none' || style.filter !== 'none' || style.perspective !== 'none') {
      return node
    }
    node = node.parentElement
  }
  return null
}

// The nearest ancestor whose overflow actually clips. `overflow: clip` clips
// too, and `overflow-x: visible` next to a clipped `overflow-y` computes to a
// clipped axis, so both axes are read.
export const findClippingAncestor = (start: HTMLElement): HTMLElement | null => {
  let node = start.parentElement
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node)
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
      return node
    }
    node = node.parentElement
  }
  return null
}

const boundingRect = (element: Element): PopoverRect => {
  const rect = element.getBoundingClientRect()
  return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top }
}

const translate = (rect: PopoverRect, dx: number, dy: number): PopoverRect => ({
  bottom: rect.bottom + dy,
  left: rect.left + dx,
  right: rect.right + dx,
  top: rect.top + dy,
})

export const resolveClipRect = (anchor: HTMLElement, panel: HTMLElement): PopoverRect => {
  const container = fixedContainingBlock(panel)
  if (container) {
    const box = boundingRect(container)
    const clipping = findClippingAncestor(anchor)
    if (clipping && container.contains(clipping)) {
      // Both boxes are in window coordinates; the panel lands relative to the
      // containing block, so express the intersection in its frame.
      const clip = boundingRect(clipping)
      return translate(
        {
          bottom: Math.min(clip.bottom, box.bottom),
          left: Math.max(clip.left, box.left),
          right: Math.min(clip.right, box.right),
          top: Math.max(clip.top, box.top),
        },
        -box.left,
        -box.top,
      )
    }
    return { bottom: box.bottom - box.top, left: 0, right: box.right - box.left, top: 0 }
  }
  const clipping = findClippingAncestor(anchor)
  return clipping ? boundingRect(clipping) : windowClip()
}

export type MeasuredPopoverPlacement = ClampedPopoverPlacement & {
  /** The measured (or anchor-matched) panel width, for centre-anchored callers. */
  panelWidth: number
}

export type PopoverPlacementOptions = {
  /** The element or rect the panel hangs off. */
  anchor: PopoverAnchorInput | null
  /** Sizes the panel to its anchor, the way a combobox listbox matches its input. */
  matchAnchorWidth?: boolean
  open: boolean
  panelRef: RefObject<HTMLElement | null>
  placement?: PopoverPlacement
}

/**
 * Resolves the clamped position of an anchored panel against the anchor's real
 * clipping box. Returns `null` until the first measurement (or while closed),
 * so the caller keeps the panel laid out but unpainted until it has a home.
 */
export const usePopoverPlacement = ({
  anchor,
  matchAnchorWidth = false,
  open,
  panelRef,
  placement = 'bottom-start',
}: PopoverPlacementOptions): MeasuredPopoverPlacement | null => {
  const [placed, setPlaced] = useState<MeasuredPopoverPlacement | null>(null)

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!open || !anchor || !panel) {
      setPlaced(null)
      return undefined
    }

    const measure = (): void => {
      const panelRect = panel.getBoundingClientRect()
      const anchorRect = anchor.kind === 'element' ? boundingRect(anchor.element) : anchor.rect
      const container = fixedContainingBlock(panel)
      const origin = container ? boundingRect(container) : { left: 0, top: 0 }
      const panelWidth = matchAnchorWidth
        ? anchorRect.right - anchorRect.left
        : panelRect.width
      const next = placePopoverInRect({
        anchor: translate(anchorRect, -origin.left, -origin.top),
        clip:
          anchor.kind === 'element' ? resolveClipRect(anchor.element, panel) : windowClip(),
        panel: { height: panelRect.height, width: panelWidth },
        placement,
      })
      const value: MeasuredPopoverPlacement = { ...next, panelWidth }
      setPlaced((current) =>
        current
        && current.left === value.left
        && current.top === value.top
        && current.placement === value.placement
        && current.maxHeight === value.maxHeight
        && current.panelWidth === value.panelWidth
          ? current
          : value,
      )
    }

    measure()

    // ResizeObserver is browser-only: jsdom has none, and a popover rendered
    // in a unit test would otherwise throw on mount. The measurement above has
    // already run, so without the observer placement is simply static rather
    // than reactive — the right degradation for an environment that never
    // reflows.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    // One observer watches every box the placement derives from: the panel
    // itself (its size settles as content loads), the anchor and its clipping
    // ancestor (sidebar/thread reflow moves both), and the document body (a
    // window resize reaches it without a window listener).
    observer.observe(panel)
    if (anchor.kind === 'element') {
      observer.observe(anchor.element)
      const container = fixedContainingBlock(panel)
      const clipping = findClippingAncestor(anchor.element)
      if (clipping) observer.observe(clipping)
      if (container) {
        observer.observe(container)
      } else {
        observer.observe(document.body)
      }
    } else {
      observer.observe(document.body)
    }

    // A scroll inside any ancestor — a message feed, a settings form — moves
    // the anchor inside its clipping box without resizing anything.
    window.addEventListener('scroll', measure, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', measure, true)
    }
  }, [anchor, matchAnchorWidth, open, panelRef, placement])

  return placed
}
