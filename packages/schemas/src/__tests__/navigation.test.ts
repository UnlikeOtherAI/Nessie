import assert from 'node:assert/strict'
import test from 'node:test'

import { buildChannelMessagePath } from '../navigation.js'

test('opens a reply at its root conversation', () => {
  assert.equal(buildChannelMessagePath({
    channelId: 'channel-1',
    messageId: 'reply-1',
    rootMessageId: 'root-1',
    threadId: 'thread-1',
  }), '/channels/channel-1/threads/thread-1/replies/root-1')
})

test('opens a top-level message as its own conversation root', () => {
  assert.equal(buildChannelMessagePath({
    channelId: 'channel-1',
    messageId: 'message-1',
    threadId: 'thread-1',
  }), '/channels/channel-1/threads/thread-1/replies/message-1')
})
