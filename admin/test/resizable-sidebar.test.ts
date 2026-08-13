import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampSidebarWidthPercent,
  minimumSidebarWidthPercent,
  parseStoredSidebarWidthPercent,
} from '../src/layouts/admin-shell/ResizableSidebar'

test('sidebar width is capped at 35% of the viewport', () => {
  assert.equal(clampSidebarWidthPercent(42, 1_440), 35)
})

test('sidebar width preserves a usable 200px minimum on narrower tablets', () => {
  assert.equal(minimumSidebarWidthPercent(800), 25)
  assert.equal(clampSidebarWidthPercent(18, 800), 25)
})

test('a stored viewport-relative width remains proportional when it is in bounds', () => {
  assert.equal(clampSidebarWidthPercent(28.5, 1_200), 28.5)
})

test('an absent device preference uses the current sidebar width as its baseline', () => {
  assert.equal(parseStoredSidebarWidthPercent(null), null)
  assert.equal(parseStoredSidebarWidthPercent('30'), 30)
})
