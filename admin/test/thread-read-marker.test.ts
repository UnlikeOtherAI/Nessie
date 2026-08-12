import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldMarkThreadRead } from '../src/pages/channels/thread-read-marker.js'

test('acknowledges a new message only while the Messages surface is visible', () => {
  const input = {
    lastReadMarker: null,
    latestMessageId: 'message-1',
    pendingReadMarker: null,
    threadId: 'thread-1',
  }

  assert.equal(shouldMarkThreadRead({ ...input, enabled: false }), null)
  assert.equal(shouldMarkThreadRead({ ...input, enabled: true }), 'thread-1:message-1')
})

test('does not duplicate a pending or acknowledged read marker', () => {
  const input = {
    enabled: true,
    latestMessageId: 'message-1',
    threadId: 'thread-1',
  }

  assert.equal(shouldMarkThreadRead({ ...input, lastReadMarker: 'thread-1:message-1', pendingReadMarker: null }), null)
  assert.equal(shouldMarkThreadRead({ ...input, lastReadMarker: null, pendingReadMarker: 'thread-1:message-1' }), null)
})
