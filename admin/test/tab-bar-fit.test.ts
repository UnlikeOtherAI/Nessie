import assert from 'node:assert/strict'
import test from 'node:test'

import { decideTabBarCollapse } from '../src/components/primitives/tab-bar-fit.js'

// The shape of the strip is decided by two lengths. These assert the decision
// itself; `tab-bar-render.test.ts` asserts what each shape renders.

test('a strip that fits its room stays a strip', () => {
  assert.equal(decideTabBarCollapse({ available: 600, collapsed: false, natural: 380 }), false)
})

test('a strip wider than its room becomes a dropdown', () => {
  assert.equal(decideTabBarCollapse({ available: 240, collapsed: false, natural: 380 }), true)
})

test('a dropdown becomes a strip again once the room comes back', () => {
  // The reverse direction is the one a ResizeObserver drives, and the one a
  // browser stops delivering while its tab is hidden — so it is asserted here.
  assert.equal(decideTabBarCollapse({ available: 700, collapsed: true, natural: 380 }), false)
})

test('neither shape can argue itself into the other at the boundary', () => {
  // `natural` is the width of the labels and `available` the width of the
  // container; neither changes with the shape, so feeding each answer back in
  // must reach the same one. A width that disagreed with itself here would
  // flicker between a strip and a dropdown on screen.
  const natural = 380
  for (const available of [378, 379, 380, 381, 382, 500]) {
    const fromStrip = decideTabBarCollapse({ available, collapsed: false, natural })
    const fromDropdown = decideTabBarCollapse({ available, collapsed: true, natural })
    assert.equal(fromStrip, fromDropdown, `available=${available} disagrees with itself`)
    assert.equal(
      decideTabBarCollapse({ available, collapsed: fromStrip, natural }),
      fromStrip,
      `available=${available} does not settle`,
    )
  }
})

test('a sub-pixel overflow is not a reason to collapse', () => {
  assert.equal(decideTabBarCollapse({ available: 380, collapsed: false, natural: 380.5 }), false)
})

test('an unmeasurable box keeps the shape it has', () => {
  // A closed panel and a screen mid-transition both measure zero. Reading that
  // as "nothing fits" would collapse every strip the moment it was hidden, and
  // it would still be a dropdown when the panel opened again.
  assert.equal(decideTabBarCollapse({ available: 0, collapsed: false, natural: 380 }), false)
  assert.equal(decideTabBarCollapse({ available: 0, collapsed: true, natural: 380 }), true)
  assert.equal(decideTabBarCollapse({ available: -1, collapsed: false, natural: 380 }), false)
})

test('nothing measured yet keeps the strip the first render put on screen', () => {
  assert.equal(decideTabBarCollapse({ available: 240, collapsed: false, natural: null }), false)
})
