import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  OVERLAY_BACK_PRIORITY,
  OVERLAY_LAYER,
  overlayDurationMs,
  overlayKeyframes,
  runOverlayTransition,
} from '../src/navigation/overlay'
import { OVERLAY_MOTION } from '../src/navigation/motion'
import { LOCAL_BACK_PRIORITY } from '../src/navigation/LocalBackContext'

const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('the layer tokens in styles.css mirror OVERLAY_LAYER exactly', () => {
  for (const [name, value] of Object.entries(OVERLAY_LAYER)) {
    assert.match(styles, new RegExp(`--layer-${name}: ${value};`), name)
  }
})

test('an overlay outranks every nested stage and column for Back, and blocking outranks modal', () => {
  const stageMax = Math.max(...Object.values(LOCAL_BACK_PRIORITY))
  assert.ok(OVERLAY_BACK_PRIORITY.popover > stageMax + 20, 'above any column depth in reach')
  assert.ok(OVERLAY_BACK_PRIORITY.sheet > OVERLAY_BACK_PRIORITY.popover)
  assert.ok(OVERLAY_BACK_PRIORITY.modal > OVERLAY_BACK_PRIORITY.sheet)
  assert.ok(OVERLAY_BACK_PRIORITY.blocking > OVERLAY_BACK_PRIORITY.modal)
  assert.ok(OVERLAY_LAYER.card < OVERLAY_LAYER.tooltip && OVERLAY_LAYER.tooltip < OVERLAY_LAYER.popover)
  assert.ok(OVERLAY_LAYER.popover < OVERLAY_LAYER.sheet)
  assert.ok(OVERLAY_LAYER.sheet < OVERLAY_LAYER.modal && OVERLAY_LAYER.modal < OVERLAY_LAYER.blocking)
})

test('each kind moves on its own token; reduced motion is 0 ms through the same path', () => {
  assert.equal(overlayDurationMs('modal', false), OVERLAY_MOTION.modalMs)
  assert.equal(overlayDurationMs('blocking', false), OVERLAY_MOTION.modalMs)
  assert.equal(overlayDurationMs('popover', false), OVERLAY_MOTION.popoverMs)
  assert.equal(overlayDurationMs('sheet', false), OVERLAY_MOTION.drawerMs)
  assert.equal(overlayDurationMs('card', false), OVERLAY_MOTION.cardMs)
  assert.equal(overlayDurationMs('modal', true), 0)
})

test('a modal fades with a 4 px rise and no scale; a sheet slides from its edge', () => {
  const [from, to] = overlayKeyframes('modal', 'open')
  assert.deepEqual(from, { opacity: '0', transform: 'translate3d(0, 4px, 0)' })
  assert.deepEqual(to, { opacity: '1', transform: 'translate3d(0, 0, 0)' })
  assert.deepEqual(overlayKeyframes('modal', 'close'), [to, from])
  assert.equal(overlayKeyframes('sheet', 'open', 'left')[0]?.transform, 'translate3d(-100%, 0, 0)')
  assert.equal(overlayKeyframes('sheet', 'open', 'bottom')[0]?.transform, 'translate3d(0, 100%, 0)')
  for (const frames of [overlayKeyframes('modal', 'open'), overlayKeyframes('popover', 'open')]) {
    assert.doesNotMatch(JSON.stringify(frames), /scale/)
  }
})

test('without a Web Animations API an overlay transition resolves at once', async () => {
  const run = runOverlayTransition({ direction: 'open', element: null, kind: 'modal', reducedMotion: false })
  assert.equal(run.durationMs, OVERLAY_MOTION.modalMs)
  await run.finished
  run.cancel()
})


test('a hover hint sits on the scale, below every kind a person interacts with', () => {
  // Both fixed hints had picked their own number (90 and 80), which put a rail
  // tooltip over an open dialog. They now read the token.
  assert.doesNotMatch(styles, /\.rail-tooltip \{[^}]*z-index: \d/)
  assert.doesNotMatch(styles, /\.group-dm-sidebar-tooltip \{[^}]*z-index: \d/)
  for (const rule of ['.rail-tooltip', '.group-dm-sidebar-tooltip']) {
    const block = styles.slice(styles.indexOf(`${rule} {`))
    assert.match(block.slice(0, block.indexOf('}')), /z-index: var\(--layer-tooltip\)/, rule)
  }
})
