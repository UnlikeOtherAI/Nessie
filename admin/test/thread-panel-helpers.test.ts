import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clampThreadPanelWidth,
  getReplyBroadcastRootId,
  readThreadPanelWidth,
  THREAD_PANEL_DEFAULT_WIDTH,
  THREAD_PANEL_MIN_WIDTH,
} from '../src/components/features/channels/thread-panel/thread-panel-helpers.js'

test('clampThreadPanelWidth keeps values inside 320px..50vw', () => {
  assert.equal(clampThreadPanelWidth(400, 1600), 400)
  assert.equal(clampThreadPanelWidth(100, 1600), THREAD_PANEL_MIN_WIDTH)
  assert.equal(clampThreadPanelWidth(1200, 1600), 800)
  // A narrow viewport caps the width at the minimum (min wins over 50vw).
  assert.equal(clampThreadPanelWidth(400, 500), THREAD_PANEL_MIN_WIDTH)
})

test('clampThreadPanelWidth falls back to the default for non-finite input', () => {
  assert.equal(clampThreadPanelWidth(Number.NaN, 1600), THREAD_PANEL_DEFAULT_WIDTH)
  assert.equal(clampThreadPanelWidth(Number.POSITIVE_INFINITY, 1600), THREAD_PANEL_DEFAULT_WIDTH)
})

test('readThreadPanelWidth parses stored values and tolerates garbage', () => {
  assert.equal(readThreadPanelWidth('450', 1600), 450)
  assert.equal(readThreadPanelWidth(null, 1600), THREAD_PANEL_DEFAULT_WIDTH)
  assert.equal(readThreadPanelWidth('not-a-number', 1600), THREAD_PANEL_DEFAULT_WIDTH)
  assert.equal(readThreadPanelWidth('10', 1600), THREAD_PANEL_MIN_WIDTH)
})

test('getReplyBroadcastRootId reads metadata.replyBroadcast.rootMessageId', () => {
  assert.equal(
    getReplyBroadcastRootId({ replyBroadcast: { rootMessageId: 'msg-1' } }),
    'msg-1',
  )
  assert.equal(getReplyBroadcastRootId({ replyBroadcast: {} }), null)
  assert.equal(getReplyBroadcastRootId({ replyBroadcast: 'msg-1' }), null)
  assert.equal(getReplyBroadcastRootId({ replyBroadcast: { rootMessageId: 42 } }), null)
  assert.equal(getReplyBroadcastRootId({}), null)
  assert.equal(getReplyBroadcastRootId(undefined), null)
})
