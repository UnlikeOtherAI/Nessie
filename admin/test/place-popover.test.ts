import assert from 'node:assert/strict'
import test from 'node:test'

import {
  placePopover,
  POPOVER_GAP,
  POPOVER_GUTTER,
  type PopoverAnchorRect,
  type PopoverPlacement,
} from '../src/components/overlays/placePopover.js'

/**
 * The one placement helper (docs/navigation.md §7). Five call sites used to
 * carry a private version of this arithmetic and three of them had no flip at
 * all, so a menu opened near the bottom of a short window simply ran off it.
 * These pin the two halves of the promise: the preferred side is used whenever
 * it fits, and the panel is always inside the bounds afterwards.
 */

const BOUNDS = { bottom: 800, left: 0, right: 1_000, top: 0 }
const PANEL = { height: 200, width: 300 }

const anchorAt = (left: number, top: number, width = 40, height = 32): PopoverAnchorRect => ({
  bottom: top + height,
  left,
  right: left + width,
  top,
})

const place = (
  anchor: PopoverAnchorRect,
  placement: PopoverPlacement,
  bounds = BOUNDS,
  panel = PANEL,
) => placePopover({ anchor, bounds, panel, placement })

test('the preferred side is used whenever the panel fits there', () => {
  const anchor = anchorAt(400, 300)
  const below = place(anchor, 'bottom-start')
  assert.equal(below.placement, 'bottom-start')
  assert.equal(below.top, anchor.bottom + POPOVER_GAP)
  assert.equal(below.left, anchor.left)

  const above = place(anchor, 'top-start')
  assert.equal(above.placement, 'top-start')
  assert.equal(above.top, anchor.top - POPOVER_GAP - PANEL.height)

  const beside = place(anchor, 'right')
  assert.equal(beside.placement, 'right')
  assert.equal(beside.left, anchor.right + POPOVER_GAP)
  // `right`/`left` are top-aligned with their anchor.
  assert.equal(beside.top, anchor.top)
})

test('an -end placement aligns the panel to the anchor’s right edge', () => {
  const anchor = anchorAt(600, 100, 120)
  const placed = place(anchor, 'bottom-end')
  assert.equal(placed.left, anchor.right - PANEL.width)
})

// ---------------------------------------------------------------------------
// Flip
// ---------------------------------------------------------------------------

test('a panel that would run off the bottom flips above its anchor', () => {
  const anchor = anchorAt(400, 700)
  const placed = place(anchor, 'bottom-start')
  assert.equal(placed.placement, 'top-start')
  assert.equal(placed.top, anchor.top - POPOVER_GAP - PANEL.height)
})

test('a panel that would run off the top flips below its anchor', () => {
  const anchor = anchorAt(400, 40)
  const placed = place(anchor, 'top-end')
  assert.equal(placed.placement, 'bottom-end')
  assert.equal(placed.top, anchor.bottom + POPOVER_GAP)
})

test('a side-anchored panel flips across its anchor rather than covering it', () => {
  const anchor = anchorAt(900, 300)
  const placed = place(anchor, 'right')
  assert.equal(placed.placement, 'left')
  assert.equal(placed.left, anchor.left - POPOVER_GAP - PANEL.width)
})

test('when neither side fits the roomier one wins, and the panel is still inside', () => {
  // A 700 px panel in an 800 px window: 300 px above the anchor, 468 below.
  const anchor = anchorAt(400, 300)
  const tall = { height: 700, width: 300 }
  const placed = place(anchor, 'top-start', BOUNDS, tall)
  assert.equal(placed.placement, 'bottom-start')
  // Too tall for the window either way, so it is pinned to the trailing gutter
  // and reports the room it actually has — a scrolling panel uses maxHeight.
  assert.equal(placed.top, BOUNDS.bottom - POPOVER_GUTTER - tall.height)
  assert.ok(placed.top >= BOUNDS.top + POPOVER_GUTTER)
})

// ---------------------------------------------------------------------------
// Clamp
// ---------------------------------------------------------------------------

test('the cross axis is clamped into the bounds on both edges', () => {
  const rightEdge = place(anchorAt(960, 300), 'bottom-start')
  assert.equal(rightEdge.left, BOUNDS.right - POPOVER_GUTTER - PANEL.width)

  const leftEdge = place(anchorAt(-40, 300), 'bottom-start')
  assert.equal(leftEdge.left, BOUNDS.left + POPOVER_GUTTER)
})

test('a side-anchored panel opened at the very bottom is pulled back on screen', () => {
  // The rail's account menu: its trigger sits at the bottom of a tall column.
  const placed = place(anchorAt(56, 770, 32, 32), 'right')
  assert.equal(placed.placement, 'right')
  assert.equal(placed.top, BOUNDS.bottom - POPOVER_GUTTER - PANEL.height)
  assert.equal(placed.left, 56 + 32 + POPOVER_GAP)
})

test('an anchor above the top edge never pushes the panel off it', () => {
  const placed = place(anchorAt(400, -300), 'right')
  assert.equal(placed.top, BOUNDS.top + POPOVER_GUTTER)
})

test('maxHeight is the room left under the placed panel, never negative', () => {
  const placed = place(anchorAt(400, 300), 'bottom-start')
  assert.equal(placed.maxHeight, BOUNDS.bottom - POPOVER_GUTTER - placed.top)

  const squeezed = placePopover({
    anchor: anchorAt(10, 10),
    bounds: { bottom: 40, left: 0, right: 200, top: 0 },
    panel: { height: 400, width: 180 },
    placement: 'bottom-start',
  })
  assert.ok(squeezed.maxHeight >= 0)
  assert.ok(squeezed.top >= 0)
})

test('a panel wider than its bounds is pinned to the leading gutter, not pushed off', () => {
  const placed = placePopover({
    anchor: anchorAt(100, 100),
    bounds: { bottom: 600, left: 0, right: 200, top: 0 },
    panel: { height: 100, width: 400 },
    placement: 'bottom-start',
  })
  assert.equal(placed.left, POPOVER_GUTTER)
})

test('bounds need not be the window: a container rect clips just as well', () => {
  const container = { bottom: 500, left: 100, right: 400, top: 100 }
  const placed = placePopover({
    anchor: anchorAt(380, 200),
    bounds: container,
    panel: { height: 100, width: 200 },
    placement: 'bottom-start',
  })
  assert.equal(placed.left, container.right - POPOVER_GUTTER - 200)
  assert.ok(placed.top >= container.top + POPOVER_GUTTER)
})

test('the gap and gutter are inputs, so a caller can tighten either', () => {
  const placed = placePopover({
    anchor: anchorAt(400, 300),
    bounds: BOUNDS,
    gap: 0,
    gutter: 24,
    panel: PANEL,
    placement: 'bottom-start',
  })
  assert.equal(placed.top, 332)
  const clamped = placePopover({
    anchor: anchorAt(990, 300),
    bounds: BOUNDS,
    gutter: 24,
    panel: PANEL,
    placement: 'bottom-start',
  })
  assert.equal(clamped.left, BOUNDS.right - 24 - PANEL.width)
})
