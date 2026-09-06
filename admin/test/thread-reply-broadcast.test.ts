import assert from 'node:assert/strict'
import test from 'node:test'

import { getReplyBroadcastRootId } from '../src/components/features/channels/thread-panel/thread-replies.js'

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
