import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decideEventPersistence } from '../src/dedupe.js'
import type { NormalizedEvent } from '../src/events.js'

const baseEvent = (overrides: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  canonicalMessageId: 'slack:T:C:1',
  version: 1,
  isDeleted: false,
  provider: 'slack',
  externalTenantId: 'T',
  conversationId: 'C',
  messageId: '1',
  eventType: 'message',
  occurredAt: '2026-07-21T00:00:00.000Z',
  participants: [],
  attachments: [],
  mentions: [],
  reactions: [],
  visibility: 'channel',
  ...overrides,
})

test('inserts a brand-new message at version 1', () => {
  const decision = decideEventPersistence(baseEvent({ contentText: 'hi' }))
  assert.deepEqual(decision, { action: 'insert-new', version: 1 })
})

test('skips an unchanged re-import', () => {
  const incoming = baseEvent({ contentText: 'hi' })
  const decision = decideEventPersistence(incoming, {
    version: 1,
    isDeleted: false,
    contentText: 'hi',
  })
  assert.deepEqual(decision, { action: 'skip-duplicate', version: 1 })
})

test('creates a new version when content changed', () => {
  const incoming = baseEvent({ contentText: 'edited', editedAt: '2026-07-21T01:00:00.000Z' })
  const decision = decideEventPersistence(incoming, {
    version: 2,
    isDeleted: false,
    contentText: 'hi',
  })
  assert.deepEqual(decision, { action: 'new-version', version: 3 })
})

test('a deletion is a new version', () => {
  const incoming = baseEvent({ contentText: 'hi', isDeleted: true })
  const decision = decideEventPersistence(incoming, {
    version: 1,
    isDeleted: false,
    contentText: 'hi',
  })
  assert.deepEqual(decision, { action: 'new-version', version: 2 })
})

test('reaction-only churn does not create a new version', () => {
  const incoming = baseEvent({
    contentText: 'hi',
    reactions: [{ key: 'thumbsup', count: 3 }],
  })
  const decision = decideEventPersistence(incoming, {
    version: 1,
    isDeleted: false,
    contentText: 'hi',
  })
  assert.equal(decision.action, 'skip-duplicate')
})
