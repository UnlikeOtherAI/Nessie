import assert from 'node:assert/strict'
import test from 'node:test'

import { isAttentionMessage, isScreenBarMessage, isScreenMessage } from './native-shell-message'
import type { NativeShellMessage } from './native-shell-message'

const VALID_SCREEN: NativeShellMessage = {
  depth: 2,
  hasBack: true,
  path: '/channels/channel_1',
  screenType: 'detail',
  section: 'channels',
  title: 'General',
  type: 'nessie:screen',
}

test('isScreenMessage accepts only a complete nessie:screen bridge message', () => {
  assert.equal(isScreenMessage(VALID_SCREEN), true)
  // Every known section and screen type is accepted.
  for (const section of ['channels', 'projects', 'knowledge', 'admin', 'search']) {
    assert.equal(isScreenMessage({ ...VALID_SCREEN, section }), true, section)
  }
  for (const screenType of ['root', 'detail', 'nested', 'tabHost', 'flow']) {
    assert.equal(isScreenMessage({ ...VALID_SCREEN, screenType }), true, screenType)
  }
})

test('isScreenMessage rejects the wrong bridge type', () => {
  // Wrong type — a distinct bridge capability, never the generic route message.
  assert.equal(isScreenMessage({ ...VALID_SCREEN, type: 'nessie:route' }), false)
})

test('isScreenMessage rejects an unrecognized section or screen type', () => {
  assert.equal(isScreenMessage({ ...VALID_SCREEN, section: 'dashboard' }), false)
  assert.equal(isScreenMessage({ ...VALID_SCREEN, screenType: 'modal' }), false)
})

test('isScreenMessage rejects a message missing any required field', () => {
  assert.equal(isScreenMessage({ ...VALID_SCREEN, path: undefined }), false)
  assert.equal(isScreenMessage({ ...VALID_SCREEN, title: undefined }), false)
  assert.equal(isScreenMessage({ ...VALID_SCREEN, depth: undefined }), false)
  assert.equal(isScreenMessage({ ...VALID_SCREEN, hasBack: undefined }), false)
})

test('isAttentionMessage accepts only a nessie:attention message carrying a badges object', () => {
  assert.equal(isAttentionMessage({ type: 'nessie:attention', badges: { channels: 3 } }), true)
  // An empty map is still a valid (all-zero) attention message.
  assert.equal(isAttentionMessage({ type: 'nessie:attention', badges: {} }), true)
  // Wrong type — a distinct bridge capability, never the generic presentation payload.
  assert.equal(isAttentionMessage({ type: 'nessie:team', badges: { channels: 3 } }), false)
  // Missing or malformed badges.
  assert.equal(isAttentionMessage({ type: 'nessie:attention' }), false)
  assert.equal(
    isAttentionMessage({ type: 'nessie:attention', badges: null } as unknown as NativeShellMessage),
    false,
  )
})

test('a screen-bar message carries a title and an optional named Back', () => {
  assert.equal(isScreenBarMessage({
    type: 'nessie:screen-bar',
    actions: [{ id: 'star', kind: 'button', label: 'Star', priority: 40 }],
    layerKey: 'channels:2:channels:channel',
    title: 'Design review',
    back: { label: 'Channels' },
  }), true)
  // A layer that has not published yet: an empty title and no Back is a
  // legitimate bar, and the band renders bare rather than falling back to a
  // root's team controls.
  assert.equal(isScreenBarMessage({
    type: 'nessie:screen-bar',
    actions: [],
    layerKey: null,
    title: '',
    back: null,
  }), true)
})

test('a malformed screen-bar message is refused rather than half-rendered', () => {
  assert.equal(isScreenBarMessage({ type: 'nessie:screen-bar' } as never), false)
  // Every field is required even when empty: a half-message would leave a
  // stale bar sitting over the new screen until the next navigation.
  assert.equal(isScreenBarMessage({ type: 'nessie:screen-bar', title: 'x' } as never), false)
  assert.equal(isScreenBarMessage({
    type: 'nessie:screen-bar',
    title: 'x',
    layerKey: null,
    back: null,
  } as never), false)
  assert.equal(isScreenBarMessage({
    type: 'nessie:screen-bar',
    actions: [],
    title: 'Design review',
    back: { label: 7 },
  } as never), false)
  // One malformed action refuses the whole bar: a control silently dropped is
  // the failure Rule zero names, and the bar would look complete without it.
  assert.equal(isScreenBarMessage({
    type: 'nessie:screen-bar',
    actions: [{ id: 'star', kind: 'wat', label: 'Star', priority: 1 }],
    layerKey: null,
    title: 'Design review',
    back: null,
  } as never), false)
  assert.equal(isScreenBarMessage({
    type: 'nessie:screen-bar',
    title: 'Design review',
    layerKey: 12,
  } as never), false)
  assert.equal(isScreenBarMessage({ type: 'nessie:screen', title: 'x' } as never), false)
})
