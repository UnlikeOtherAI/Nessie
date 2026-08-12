import assert from 'node:assert/strict'
import test from 'node:test'

import {
  claimMessageNotification,
  isMessageCreatedEvent,
  shouldSuppressMessageBanner,
} from '../src/facades/notifications/useMessageNotifications.js'

test('suppresses an in-app banner only for the exact focused conversation', () => {
  assert.equal(shouldSuppressMessageBanner({
    activeThreadId: 'thread-a',
    activeRootMessageId: 'root-a',
    foreground: true,
    rootMessageId: 'root-a',
    threadId: 'thread-a',
  }), true)
})

test('keeps an in-app banner for another thread or an unfocused window', () => {
  assert.equal(shouldSuppressMessageBanner({
    activeThreadId: 'thread-a',
    activeRootMessageId: 'root-a',
    foreground: true,
    rootMessageId: 'root-b',
    threadId: 'thread-a',
  }), false)
  assert.equal(shouldSuppressMessageBanner({
    activeThreadId: 'thread-a',
    activeRootMessageId: 'root-a',
    foreground: true,
    threadId: 'thread-b',
  }), false)
  assert.equal(shouldSuppressMessageBanner({
    activeThreadId: 'thread-a',
    activeRootMessageId: 'root-a',
    foreground: false,
    rootMessageId: 'root-a',
    threadId: 'thread-a',
  }), false)
})

test('recognizes agent reply events as newly created messages for banners', () => {
  assert.equal(isMessageCreatedEvent('message.new'), true)
  assert.equal(isMessageCreatedEvent('message.reply'), true)
  assert.equal(isMessageCreatedEvent('message.reply.meta'), false)
})

test('claims each realtime message before asynchronous notification work begins', () => {
  const claimed = new Set<string>()

  assert.equal(claimMessageNotification(claimed, 'message-a'), true)
  assert.equal(claimMessageNotification(claimed, 'message-a'), false)
  assert.equal(claimMessageNotification(claimed, 'message-b'), true)
})
