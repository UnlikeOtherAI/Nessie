import assert from 'node:assert/strict'
import test from 'node:test'

import { FOCUS_CHROME_DURATION_MS, easeStandard, mixColor } from './chrome-transition'
import {
  NATIVE_CHROME_KEYS,
  blendNativeChrome,
  pickNativeChrome,
} from '../components/native-focus-chrome'
import { DEFAULT_NATIVE_SHELL_PRESENTATION } from '../components/native-shell-presentation'

test('the transition matches the duration the admin animates its palette over', () => {
  assert.equal(FOCUS_CHROME_DURATION_MS, 300)
})

test('the easing pins both ends and stays inside them', () => {
  assert.equal(easeStandard(0), 0)
  assert.equal(easeStandard(1), 1)
  for (let i = 1; i < 20; i += 1) {
    const value = easeStandard(i / 20)
    assert.ok(value > 0 && value < 1, `eased ${i / 20} left the unit range: ${value}`)
  }
})

test('the easing only ever moves forwards', () => {
  let previous = -1
  for (let i = 0; i <= 40; i += 1) {
    const value = easeStandard(i / 40)
    assert.ok(value >= previous, `eased curve went backwards at ${i / 40}`)
    previous = value
  }
})

// `ease` front-loads its travel: half the time is well past half the distance.
test('the easing is CSS ease, not a straight line', () => {
  assert.ok(easeStandard(0.5) > 0.55)
})

test('progress outside the transition is clamped rather than extrapolated', () => {
  assert.equal(easeStandard(-1), 0)
  assert.equal(easeStandard(4), 1)
  assert.equal(mixColor('#000000', '#ffffff', -1), '#000000')
  assert.equal(mixColor('#000000', '#ffffff', 9), '#ffffff')
})

test('a colour travels through its midpoint instead of snapping', () => {
  assert.equal(mixColor('#000000', '#ffffff', 0.5), 'rgb(128, 128, 128)')
})

test('the transition ends exactly on the colour it was given', () => {
  assert.equal(mixColor('#2e1132', '#242424', 0), '#2e1132')
  assert.equal(mixColor('#2e1132', '#242424', 1), '#242424')
})

test('a colour with no parseable midpoint switches rather than disappearing', () => {
  assert.equal(mixColor('not-a-colour', '#242424', 0.5), 'not-a-colour')
  assert.equal(mixColor('not-a-colour', '#242424', 1), '#242424')
})

test('translucency is carried through the transition', () => {
  assert.equal(mixColor('rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 1)', 0.5), 'rgba(0, 0, 0, 0.5)')
})

test('every chrome colour moves together, and only chrome colours move', () => {
  const themed = pickNativeChrome(DEFAULT_NATIVE_SHELL_PRESENTATION)
  const focused = pickNativeChrome({
    ...DEFAULT_NATIVE_SHELL_PRESENTATION,
    accent: '#b9b9bc',
    chromeSurface: '#353535',
    inactive: '#aeaeaf',
    phoneHeaderSurface: '#242424',
    phoneHeaderText: '#f1f1f1',
    phoneText: '#f1f1f1',
    phoneTextMuted: '#d4d4d6',
    strongAccent: '#ececee',
  })
  const midway = blendNativeChrome(themed, focused, 0.5)

  for (const key of NATIVE_CHROME_KEYS) {
    assert.notEqual(midway[key], themed[key], `${key} did not leave its themed colour`)
    assert.notEqual(midway[key], focused[key], `${key} jumped straight to focus`)
  }
  assert.equal('background' in midway, false)
  assert.deepEqual(blendNativeChrome(themed, focused, 1), focused)
  assert.deepEqual(blendNativeChrome(themed, focused, 0), themed)
})
