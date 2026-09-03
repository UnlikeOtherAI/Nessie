import assert from 'node:assert/strict'
import test from 'node:test'
import { windowLayoutBounds } from '../src/layouts/admin-shell/window-layouts'

const workArea = { height: 1079, width: 1919, x: -1280, y: 41 }

test('window layout presets fill the monitor work area without rounding gaps', () => {
  assert.deepEqual(windowLayoutBounds('left-half', workArea), {
    height: 1079,
    width: 959,
    x: -1280,
    y: 41,
  })
  assert.deepEqual(windowLayoutBounds('right-half', workArea), {
    height: 1079,
    width: 960,
    x: -321,
    y: 41,
  })
  assert.deepEqual(windowLayoutBounds('top-half', workArea), {
    height: 539,
    width: 1919,
    x: -1280,
    y: 41,
  })
  assert.deepEqual(windowLayoutBounds('bottom-half', workArea), {
    height: 540,
    width: 1919,
    x: -1280,
    y: 580,
  })
})

test('third layouts cover every pixel on mixed-DPI work areas', () => {
  assert.deepEqual(windowLayoutBounds('left-third', workArea), {
    height: 1079,
    width: 639,
    x: -1280,
    y: 41,
  })
  assert.deepEqual(windowLayoutBounds('middle-third', workArea), {
    height: 1079,
    width: 639,
    x: -641,
    y: 41,
  })
  assert.deepEqual(windowLayoutBounds('right-third', workArea), {
    height: 1079,
    width: 641,
    x: -2,
    y: 41,
  })
  assert.deepEqual(windowLayoutBounds('fill', workArea), {
    height: 1079,
    width: 1919,
    x: -1280,
    y: 41,
  })
})
