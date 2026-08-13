import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationParentPath, getConversationRoute } from '../src/lib/conversation-navigation'

test('maps conversation information routes to explicit mobile Back destinations', () => {
  const cases = [
    ['/channels/channel_a', 'conversation', '/channels'],
    ['/channels/channel_a/info', 'info', '/channels/channel_a'],
    ['/channels/channel_a/info/members', 'members', '/channels/channel_a/info'],
    ['/channels/channel_a/info/members/add', 'add-members', '/channels/channel_a/info/members'],
  ] as const

  for (const [pathname, step, parent] of cases) {
    const route = getConversationRoute(pathname)
    assert.ok(route)
    assert.deepEqual(route, { channelId: 'channel_a', step })
    assert.equal(conversationParentPath(route), parent)
  }
})

test('treats reply-thread URLs as a conversation route', () => {
  assert.deepEqual(
    getConversationRoute('/channels/channel_a/threads/thread_a/replies/message_a'),
    { channelId: 'channel_a', step: 'conversation' },
  )
})

test('does not treat Channels roots or other sections as conversation routes', () => {
  assert.equal(getConversationRoute('/channels'), null)
  assert.equal(getConversationRoute('/projects/project_a'), null)
})
