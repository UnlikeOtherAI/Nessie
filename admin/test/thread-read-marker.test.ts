import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isConversationReadReady,
  shouldMarkThreadRead,
} from '../src/pages/channels/thread-read-marker.js'

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

test('waits for a complete reply conversation before marking it read', () => {
  assert.equal(isConversationReadReady({
    isReplyConversation: true,
    messagesArePlaceholder: false,
    rootLoaded: true,
    repliesLoaded: false,
  }), false)
  assert.equal(isConversationReadReady({
    isReplyConversation: true,
    messagesArePlaceholder: false,
    rootLoaded: true,
    repliesLoaded: true,
  }), true)
  assert.equal(isConversationReadReady({
    isReplyConversation: false,
    messagesArePlaceholder: false,
    rootLoaded: false,
    repliesLoaded: false,
  }), true)
})

// Sibling swap: the feed still shows the previous channel's messages while the
// new thread loads, so the newest message id belongs to the wrong thread.
test('never marks read while the messages on screen are the previous thread\'s', () => {
  assert.equal(isConversationReadReady({
    isReplyConversation: false,
    messagesArePlaceholder: true,
    rootLoaded: true,
    repliesLoaded: true,
  }), false)
  assert.equal(isConversationReadReady({
    isReplyConversation: true,
    messagesArePlaceholder: true,
    rootLoaded: true,
    repliesLoaded: true,
  }), false)
})
