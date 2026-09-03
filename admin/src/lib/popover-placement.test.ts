import assert from 'node:assert/strict'
import test from 'node:test'

import {
  placePopoverInRect,
  PLACEMENT_GAP,
  PLACEMENT_GUTTER,
  type PopoverPlacement,
  type PopoverRect,
} from './popover-placement.js'

/**
 * The pure half of D11 (docs/plans/2026-08-13-responsive-coherence.md): the six
 * popovers that used to clamp against `window.innerWidth` measured once now
 * share one clamp against the actual clipping box — the nearest scrolling or
 * overflow-clipped ancestor of the anchor, which inside the resizable shell is
 * narrower than the window. These pin that the panel always lands inside the
 * clipping rect, flips to the roomier side when the preferred one cannot hold
 * it, and tracks the anchor when the shell reflow moves it.
 */

const WINDOW: PopoverRect = { bottom: 800, left: 0, right: 1_000, top: 0 }
const PANEL = { height: 100, width: 200 }

const anchorAt = (left: number, top: number, width = 40, height = 24): PopoverRect => ({
  bottom: top + height,
  left,
  right: left + width,
  top,
})

const place = (
  anchor: PopoverRect,
  placement: PopoverPlacement = 'bottom-start',
  clip: PopoverRect = WINDOW,
  panel = PANEL,
) => placePopoverInRect({ anchor, clip, panel, placement })

test('an anchor with plenty of room places the panel below, left-aligned, with the gap', () => {
  const anchor = anchorAt(400, 300)
  const placed = place(anchor)
  assert.equal(placed.placement, 'bottom-start')
  assert.equal(placed.top, anchor.bottom + PLACEMENT_GAP)
  assert.equal(placed.left, anchor.left)
  assert.equal(placed.maxHeight, WINDOW.bottom - PLACEMENT_GUTTER - placed.top)
})

test('an -end placement aligns the panel to the anchor’s right edge', () => {
  const anchor = anchorAt(600, 100, 120)
  const placed = place(anchor, 'bottom-end')
  assert.equal(placed.left, anchor.right - PANEL.width)
})

test('a side placement sits beside the anchor, top-aligned with it', () => {
  const anchor = anchorAt(60, 300)
  const placed = place(anchor, 'right')
  assert.equal(placed.placement, 'right')
  assert.equal(placed.left, anchor.right + PLACEMENT_GAP)
  assert.equal(placed.top, anchor.top)
})

test('the panel flips above the anchor when below does not fit', () => {
  const anchor = anchorAt(400, 750)
  const placed = place(anchor)
  assert.equal(placed.placement, 'top-start')
  assert.equal(placed.top, anchor.top - PLACEMENT_GAP - PANEL.height)
})

test('a side placement flips across the anchor when its side does not fit', () => {
  // 200px panel cannot fit in the ~932px left of this anchor? It can — use a
  // wide panel so left is forced.
  const anchor = anchorAt(800, 300)
  const placed = place(anchor, 'right', WINDOW, { height: 100, width: 500 })
  assert.equal(placed.placement, 'left')
  assert.equal(placed.left, anchor.left - PLACEMENT_GAP - 500)
})

test('when neither side fits, the roomier side wins and the panel still clamps inside', () => {
  const anchor = anchorAt(400, 200)
  const placed = place(anchor, 'bottom-start', WINDOW, { height: 700, width: 200 })
  assert.equal(placed.placement, 'bottom-start')
  assert.equal(placed.top, anchor.bottom + PLACEMENT_GAP)
})

test('the panel clamps inside a clipping box narrower than the window — the D11 case', () => {
  // A shell container clipped at [300, 700) inside a 1000px window.
  const clip: PopoverRect = { bottom: 800, left: 300, right: 700, top: 0 }
  // Anchor at the window's left edge, outside the container's left wall.
  const placed = place(anchorAt(60, 300), 'bottom-start', clip)
  assert.equal(placed.left, clip.left + PLACEMENT_GUTTER)
  // At its right wall: window clamping would have allowed up to 800px.
  const farRight = place(anchorAt(660, 300), 'bottom-start', clip)
  assert.equal(farRight.left, clip.right - PLACEMENT_GUTTER - PANEL.width)
  // maxHeight never lets the panel grow past the clipping box's far wall.
  assert.equal(placed.maxHeight, clip.bottom - PLACEMENT_GUTTER - placed.top)
})

test('the panel keeps the gutter from the top of the clipping box', () => {
  const clip: PopoverRect = { bottom: 300, left: 0, right: 400, top: 200 }
  const placed = place(anchorAt(100, 150), 'top-start', clip)
  assert.equal(placed.top, clip.top + PLACEMENT_GUTTER)
})

test('a clipping box narrower than the panel pins the panel to the near gutter', () => {
  const clip: PopoverRect = { bottom: 800, left: 100, right: 220, top: 0 }
  const placed = place(anchorAt(120, 300), 'bottom-start', clip)
  assert.equal(placed.left, clip.left + PLACEMENT_GUTTER)
})

test('the result follows the anchor: a reflowed anchor re-clamps against the same box', () => {
  const clip: PopoverRect = { bottom: 800, left: 0, right: 500, top: 0 }
  const before = place(anchorAt(300, 300), 'bottom-start', clip)
  // Sidebar opened: the anchor moved left and the box no longer holds the panel.
  const after = place(anchorAt(100, 300), 'bottom-start', clip)
  assert.equal(before.left, 300)
  assert.equal(after.left, 100)
  const squeezed = place(anchorAt(450, 300), 'bottom-start', clip)
  assert.equal(squeezed.left, clip.right - PLACEMENT_GUTTER - PANEL.width)
})
