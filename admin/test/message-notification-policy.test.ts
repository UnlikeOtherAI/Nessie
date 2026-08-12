import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isMessageCreatedEvent,
  shouldSuppressMessageBanner,
} from '../src/facades/notifications/useMessageNotifications.js'

test('suppresses an in-app banner only for the exact focused conversation', () => {
  assert.equal(shouldSuppressMessageBanner({
    activeThreadId: 'thread-a',
    foreground: true,
    threadId: 'thread-a',
  }), true)
})

test('keeps an in-app banner for another thread or an unfocused window', () => {
  assert.equal(shouldSuppressMessageBanner({
    activeThreadId: 'thread-a',
    foreground: true,
    threadId: 'thread-b',
  }), false)
  assert.equal(shouldSuppressMessageBanner({
    activeThreadId: 'thread-a',
    foreground: false,
    threadId: 'thread-a',
  }), false)
})

test('recognizes agent reply events as newly created messages for banners', () => {
  assert.equal(isMessageCreatedEvent('message.new'), true)
  assert.equal(isMessageCreatedEvent('message.reply'), true)
  assert.equal(isMessageCreatedEvent('message.reply.meta'), false)
})
