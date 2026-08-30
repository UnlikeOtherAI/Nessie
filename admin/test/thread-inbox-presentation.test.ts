import assert from 'node:assert/strict'
import test from 'node:test'

import { splitThreadInboxMessages } from '../src/pages/channels/thread-inbox-presentation'

const message = (id: string) => ({ id }) as never

test('shows a root, a collapsed middle, and the three most recent replies', () => {
  const result = splitThreadInboxMessages(message('root'), [
    message('reply-1'),
    message('reply-2'),
    message('reply-3'),
    message('reply-4'),
    message('reply-5'),
  ])

  assert.deepEqual(result.root.map((entry) => entry.id), ['root'])
  assert.deepEqual(result.recentReplies.map((entry) => entry.id), ['reply-3', 'reply-4', 'reply-5'])
  assert.equal(result.hiddenReplyCount, 2)
})

test('does not create a collapsed middle for three or fewer replies', () => {
  const result = splitThreadInboxMessages(message('root'), [
    message('reply-1'),
    message('reply-2'),
    message('reply-3'),
  ])

  assert.equal(result.hiddenReplyCount, 0)
  assert.deepEqual(result.recentReplies.map((entry) => entry.id), ['reply-1', 'reply-2', 'reply-3'])
})
