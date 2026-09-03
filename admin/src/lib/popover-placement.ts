// Pure popover placement geometry (docs/plans/2026-08-13-responsive-coherence.md D11):
// given an anchor rect, a panel size, a preferred placement and the rect of the
// clipping box — the nearest scrolling/overflow-clipped ancestor of the anchor,
// or the window when there is none — return where the panel lands, flipped to
// the opposite side when the preferred one does not fit and clamped so it never
// leaves the clipping box. React-free and DOM-free: the caller measures
// (usePopoverPlacement) and renders.

export type PopoverRect = {
  bottom: number
  left: number
  right: number
  top: number
}

export type PopoverPanelSize = {
  height: number
  width: number
}

export type PopoverPlacement =
  | 'bottom-start'
  | 'bottom-end'
  | 'top-start'
  | 'top-end'
  | 'right'
  | 'left'

export type ClampedPopoverPlacement = {
  left: number
  /**
   * What the panel may grow to before it would leave the clipping box. A
   * scrolling panel applies it as `max-height`; a short one ignores it.
   */
  maxHeight: number
  /** The placement actually used — the preferred one, or its flip. */
  placement: PopoverPlacement
  top: number
}

export type PlacePopoverInRectInput = {
  anchor: PopoverRect
  /** The clipping box to stay inside. */
  clip: PopoverRect
  /** The distance between the anchor and the panel along the main axis. */
  gap?: number
  /** The smallest distance the panel keeps from the clipping box on every side. */
  gutter?: number
  panel: PopoverPanelSize
  placement?: PopoverPlacement
}

export const PLACEMENT_GAP = 8
export const PLACEMENT_GUTTER = 8

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

// Where the panel's leading edge lands along the main axis, unclamped.
const mainAxisOffset = (
  placement: PopoverPlacement,
  anchor: PopoverRect,
  panel: PopoverPanelSize,
  gap: number,
): number => {
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

// How much room the placement has between the anchor and the clipping box,
// ignoring the panel — the tie-breaker when neither side fits.
const roomBeside = (
  placement: PopoverPlacement,
  anchor: PopoverRect,
  clip: PopoverRect,
  gap: number,
  gutter: number,
): number => {
  switch (placement) {
    case 'bottom-start':
    case 'bottom-end':
      return clip.bottom - gutter - (anchor.bottom + gap)
    case 'top-start':
    case 'top-end':
      return anchor.top - gap - (clip.top + gutter)
    case 'right':
      return clip.right - gutter - (anchor.right + gap)
    case 'left':
      return anchor.left - gap - (clip.left + gutter)
  }
}

export const placePopoverInRect = ({
  anchor,
  clip,
  gap = PLACEMENT_GAP,
  gutter = PLACEMENT_GUTTER,
  panel,
  placement = 'bottom-start',
}: PlacePopoverInRectInput): ClampedPopoverPlacement => {
  const flipped = FLIP[placement]
  // The preferred side wins whenever it fits. Otherwise the flip takes it if
  // *it* fits, and when neither does the roomier side is the lesser evil — the
  // panel is clamped into the clipping box below either way.
  const fits = (side: PopoverPlacement): boolean => {
    const needed = isHorizontal(side) ? panel.width : panel.height
    return roomBeside(side, anchor, clip, gap, gutter) >= needed
  }
  const resolved = fits(placement)
    ? placement
    : fits(flipped)
      ? flipped
      : roomBeside(flipped, anchor, clip, gap, gutter) > roomBeside(placement, anchor, clip, gap, gutter)
        ? flipped
        : placement

  const main = mainAxisOffset(resolved, anchor, panel, gap)
  const maxLeft = clip.right - gutter - panel.width
  const maxTop = clip.bottom - gutter - panel.height

  let left: number
  let top: number
  if (isHorizontal(resolved)) {
    left = clamp(main, clip.left + gutter, maxLeft)
    // A `right`/`left` panel is top-aligned with its anchor, then pulled back
    // inside the clipping box — which is what keeps a rail menu opened from
    // the very bottom of a short window on screen.
    top = clamp(anchor.top, clip.top + gutter, maxTop)
  } else {
    const aligned = resolved.endsWith('-end') ? anchor.right - panel.width : anchor.left
    left = clamp(aligned, clip.left + gutter, maxLeft)
    top = clamp(main, clip.top + gutter, maxTop)
  }

  return {
    left,
    maxHeight: Math.max(0, clip.bottom - gutter - top),
    placement: resolved,
    top,
  }
}
