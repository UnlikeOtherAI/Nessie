import assert from 'node:assert/strict'
import test from 'node:test'

import { pathFromPushData } from './push-navigation'

test('uses the server supplied exact conversation path for a notification', () => {
  const path = pathFromPushData({
    channelId: 'channel-a',
    messageId: 'message-a',
    rootMessageId: 'root-a',
    threadId: 'thread-a',
    url: '/channels/channel-a/threads/thread-a/replies/root-a',
  })

  assert.equal(path, '/channels/channel-a/threads/thread-a/replies/root-a')
})

test('falls back to a channel path only for legacy notification data', () => {
  assert.equal(
    pathFromPushData({ channelId: 'channel/a', messageId: 'message a' }),
    '/channels/channel%2Fa?messageId=message%20a',
  )
})
