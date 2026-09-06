import assert from 'node:assert/strict'
import test from 'node:test'

import {
  currentNativeScreenBar,
  DEFAULT_NATIVE_SCREEN_BAR_STATE,
  nativeScreenBarTransitionLanes,
  reduceNativeScreenBar,
  type NativeScreenBarState,
} from './native-screen-bar-state'
import type { NativeScreenBar } from './native-shell-layout'

const bar = (layerKey: string, title: string, backLabel: string | null = null): NativeScreenBar => ({
  actions: [],
  back: backLabel === null ? null : { label: backLabel },
  layerKey,
  title,
})

const ROOT = 'channels:0:root:channels:/channels'
const DETAIL = 'channels:1:channels:channel'

const apply = (
  state: NativeScreenBarState,
  ...actions: Parameters<typeof reduceNativeScreenBar>[1][]
): NativeScreenBarState => actions.reduce(reduceNativeScreenBar, state)

test('a forward push animates before the incoming descriptor exists', () => {
  // The real wire order: the viewport announces the transition from a layout
  // effect, so the incoming layer has not mounted or published yet.
  const state = apply(
    DEFAULT_NATIVE_SCREEN_BAR_STATE,
    { bar: bar(ROOT, ''), kind: 'bar' },
    { kind: 'transition', transition: { direction: 'forward', durationMs: 300, from: ROOT, to: DETAIL } },
  )
  const lanes = nativeScreenBarTransitionLanes(state)
  assert.equal(lanes?.outgoing?.layerKey, ROOT)
  // Blank, not the root's lanes: a team switcher must never flash above a
  // conversation on the way in.
  assert.equal(lanes?.incoming, null)

  // The descriptor lands a render later and fills the lane in place.
  const filled = apply(state, { bar: bar(DETAIL, 'Design review', 'Channels'), kind: 'bar' })
  assert.equal(nativeScreenBarTransitionLanes(filled)?.incoming?.title, 'Design review')
  assert.deepEqual(filled.transition, state.transition, 'the animation was not restarted')
})

test('the target is current from the moment the motion starts', () => {
  const state = apply(
    DEFAULT_NATIVE_SCREEN_BAR_STATE,
    { bar: bar(ROOT, ''), kind: 'bar' },
    { bar: bar(DETAIL, 'Design review', 'Channels'), kind: 'bar' },
    { kind: 'transition', transition: { direction: 'back', durationMs: 300, from: DETAIL, to: ROOT } },
  )
  // So the lanes and the status bar settle onto the screen being travelled to,
  // not the one being left.
  assert.equal(state.currentLayerKey, ROOT)
  assert.equal(currentNativeScreenBar(state)?.layerKey, ROOT)
})

test('a descriptor for any other layer is the new current screen', () => {
  const state = apply(
    DEFAULT_NATIVE_SCREEN_BAR_STATE,
    { bar: bar(ROOT, ''), kind: 'bar' },
    { kind: 'transition', transition: { direction: 'forward', durationMs: 300, from: ROOT, to: DETAIL } },
    // An unrelated layer publishes mid-flight — a sibling swap, a stage.
    { bar: bar('knowledge:1:stage:knowledge:editor', 'Onboarding', 'Back to folder'), kind: 'bar' },
  )
  assert.equal(state.currentLayerKey, 'knowledge:1:stage:knowledge:editor')
})

test('the bar comes to rest on one lane when the transition ends', () => {
  const state = apply(
    DEFAULT_NATIVE_SCREEN_BAR_STATE,
    { bar: bar(ROOT, ''), kind: 'bar' },
    { kind: 'transition', transition: { direction: 'forward', durationMs: 300, from: ROOT, to: DETAIL } },
    { bar: bar(DETAIL, 'Design review', 'Channels'), kind: 'bar' },
    { kind: 'transition-end' },
  )
  assert.equal(nativeScreenBarTransitionLanes(state), null)
  assert.equal(currentNativeScreenBar(state)?.title, 'Design review')
})

test('a long session does not accumulate a descriptor per screen ever visited', () => {
  let state = apply(DEFAULT_NATIVE_SCREEN_BAR_STATE, { bar: bar(ROOT, ''), kind: 'bar' })
  state = reduceNativeScreenBar(state, {
    kind: 'transition',
    transition: { direction: 'forward', durationMs: 300, from: ROOT, to: DETAIL },
  })
  for (let index = 0; index < 40; index += 1) {
    state = reduceNativeScreenBar(state, { bar: bar(`admin:1:seen:${index}`, `Screen ${index}`), kind: 'bar' })
  }
  assert.ok(Object.keys(state.bars).length <= 16)
  // Both ends of the live transition survive the eviction.
  assert.ok(state.bars[ROOT])
  assert.ok(state.bars[DETAIL] === undefined || state.bars[DETAIL])
  assert.equal(nativeScreenBarTransitionLanes(state)?.outgoing?.layerKey, ROOT)
})

test('nothing published yet is a bare band, never a guess', () => {
  assert.equal(currentNativeScreenBar(DEFAULT_NATIVE_SCREEN_BAR_STATE), null)
  assert.equal(nativeScreenBarTransitionLanes(DEFAULT_NATIVE_SCREEN_BAR_STATE), null)
})
