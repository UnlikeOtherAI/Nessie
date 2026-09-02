// The one placement helper for anchored overlays (docs/navigation.md §7).
//
// Five call sites hand-rolled the same flip/clamp arithmetic — the workspace
// menu, the account menu, the create menu, the reaction "who reacted" popover
// and the wikilink suggestion list — each with its own gutter, its own idea of
// which edge to give up first, and (in most of them) no flip at all, so a menu
// opened near the bottom of a short window simply ran off it. This is that
// arithmetic once: given the anchor's rect, the panel's measured size, a
// preferred placement and the clipping bounds, it returns the panel's position,
// flipped to the opposite side when the preferred one does not fit and clamped
// so the panel always stays inside the bounds.
//
// Pure: no DOM reads, no window. The caller measures; `viewportBounds()` is the
// convenience for the common case of clipping to the browser window.

export type PopoverPlacement =
  | 'bottom-start'
  | 'bottom-end'
  | 'top-start'
  | 'top-end'
  | 'right'
  | 'left'

// Anything carrying these four edges — a DOMRect, or a caret rect from an editor.
export type PopoverAnchorRect = {
  bottom: number
  left: number
  right: number
  top: number
}

export type PopoverSize = { height: number; width: number }

export type PopoverBounds = {
  bottom: number
  left: number
  right: number
  top: number
}

export type PlacePopoverInput = {
  anchor: PopoverAnchorRect
  bounds: PopoverBounds
  // The distance between the anchor and the panel along the main axis.
  gap?: number
  // The smallest distance the panel keeps from the bounds on every side.
  gutter?: number
  panel: PopoverSize
  placement: PopoverPlacement
}

export type PopoverPosition = {
  left: number
  // What the panel may grow to before it would leave the bounds. A scrolling
  // panel applies it as `max-height`; a short one ignores it.
  maxHeight: number
  // The placement actually used — the preferred one, or its flip.
  placement: PopoverPlacement
  top: number
}

export const POPOVER_GAP = 8
export const POPOVER_GUTTER = 8

const FLIP: Record<PopoverPlacement, PopoverPlacement> = {
  'bottom-end': 'top-end',
  'bottom-start': 'top-start',
  left: 'right',
  right: 'left',
  'top-end': 'bottom-end',
  'top-start': 'bottom-start',
}

const isHorizontal = (placement: PopoverPlacement): boolean =>
  placement === 'left' || placement === 'right'

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max))

type Measured = {
  anchor: PopoverAnchorRect
  bounds: PopoverBounds
  gap: number
  gutter: number
  panel: PopoverSize
}

// Where the panel's leading edge lands along the main axis, unclamped.
const mainAxisOffset = (placement: PopoverPlacement, { anchor, gap, panel }: Measured): number => {
  switch (placement) {
    case 'bottom-start':
    case 'bottom-end':
      return anchor.bottom + gap
    case 'top-start':
    case 'top-end':
      return anchor.top - gap - panel.height
    case 'right':
      return anchor.right + gap
    case 'left':
      return anchor.left - gap - panel.width
  }
}

// How much room the placement has between the anchor and the bounds, ignoring
// the panel: the tie-breaker when neither side fits.
const availableSpace = (
  placement: PopoverPlacement,
  { anchor, bounds, gap, gutter }: Measured,
): number => {
  switch (placement) {
    case 'bottom-start':
    case 'bottom-end':
      return bounds.bottom - gutter - (anchor.bottom + gap)
    case 'top-start':
    case 'top-end':
      return anchor.top - gap - (bounds.top + gutter)
    case 'right':
      return bounds.right - gutter - (anchor.right + gap)
    case 'left':
      return anchor.left - gap - (bounds.left + gutter)
  }
}

const fits = (placement: PopoverPlacement, measured: Measured): boolean => {
  const needed = isHorizontal(placement) ? measured.panel.width : measured.panel.height
  return availableSpace(placement, measured) >= needed
}

export const placePopover = ({
  anchor,
  bounds,
  gap = POPOVER_GAP,
  gutter = POPOVER_GUTTER,
  panel,
  placement,
}: PlacePopoverInput): PopoverPosition => {
  const measured: Measured = { anchor, bounds, gap, gutter, panel }
  const flipped = FLIP[placement]
  // The preferred side wins whenever it fits. Otherwise the flip takes it if
  // *it* fits, and when neither does the roomier side is the lesser evil — the
  // panel is clamped into the bounds below either way.
  const resolved = fits(placement, measured)
    ? placement
    : fits(flipped, measured)
      ? flipped
      : availableSpace(flipped, measured) > availableSpace(placement, measured)
        ? flipped
        : placement

  const main = mainAxisOffset(resolved, measured)
  const maxLeft = bounds.right - gutter - panel.width
  const maxTop = bounds.bottom - gutter - panel.height

  let left: number
  let top: number
  if (isHorizontal(resolved)) {
    left = clamp(main, bounds.left + gutter, maxLeft)
    // A `right`/`left` panel is top-aligned with its anchor, then pulled back
    // inside the bounds — which is what keeps a rail menu opened from the very
    // bottom of a short window on screen.
    top = clamp(anchor.top, bounds.top + gutter, maxTop)
  } else {
    const aligned = resolved.endsWith('-end') ? anchor.right - panel.width : anchor.left
    left = clamp(aligned, bounds.left + gutter, maxLeft)
    top = clamp(main, bounds.top + gutter, maxTop)
  }

  return {
    left,
    maxHeight: Math.max(0, bounds.bottom - gutter - top),
    placement: resolved,
    top,
  }
}

// The browser window as clipping bounds — the default for every popover that is
// not clipped by a container of its own.
export const viewportBounds = (): PopoverBounds => ({
  bottom: typeof window === 'undefined' ? 0 : window.innerHeight,
  left: 0,
  right: typeof window === 'undefined' ? 0 : window.innerWidth,
  top: 0,
})
