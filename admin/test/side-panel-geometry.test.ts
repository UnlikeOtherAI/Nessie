import assert from 'node:assert/strict'
import test from 'node:test'

import { clampSidePanelWidth, readSidePanelWidth, SIDE_PANEL_DEFAULT_WIDTH, SIDE_PANEL_MIN_WIDTH } from '../src/hooks/useSidePanelGeometry.js'

test('clampSidePanelWidth keeps values inside 320px..50vw', () => {
  assert.equal(clampSidePanelWidth(400, 1600), 400)
  assert.equal(clampSidePanelWidth(100, 1600), SIDE_PANEL_MIN_WIDTH)
  assert.equal(clampSidePanelWidth(1200, 1600), 800)
  // A narrow viewport caps the width at the minimum (min wins over 50vw).
  assert.equal(clampSidePanelWidth(400, 500), SIDE_PANEL_MIN_WIDTH)
})

test('clampSidePanelWidth falls back to the default for non-finite input', () => {
  assert.equal(clampSidePanelWidth(Number.NaN, 1600), SIDE_PANEL_DEFAULT_WIDTH)
  assert.equal(clampSidePanelWidth(Number.POSITIVE_INFINITY, 1600), SIDE_PANEL_DEFAULT_WIDTH)
})

test('readSidePanelWidth parses stored values and tolerates garbage', () => {
  assert.equal(readSidePanelWidth('450', 1600), 450)
  assert.equal(readSidePanelWidth(null, 1600), SIDE_PANEL_DEFAULT_WIDTH)
  assert.equal(readSidePanelWidth('not-a-number', 1600), SIDE_PANEL_DEFAULT_WIDTH)
  assert.equal(readSidePanelWidth('10', 1600), SIDE_PANEL_MIN_WIDTH)
})
