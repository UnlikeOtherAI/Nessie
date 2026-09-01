import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildCanonicalMessageId,
  parseCanonicalMessageId,
} from '../src/canonical-id.js'

test('builds the documented slack-style key', () => {
  const id = buildCanonicalMessageId(
    'slack',
    'T123',
    'C456',
    '1721550000.000100',
  )
  assert.equal(id, 'slack:T123:C456:1721550000.000100')
})

test('round-trips through parse', () => {
  const id = buildCanonicalMessageId('google', 'tenant', 'thread', 'msg')
  assert.deepEqual(parseCanonicalMessageId(id), {
    provider: 'google',
    tenantId: 'tenant',
    conversationId: 'thread',
    messageId: 'msg',
  })
})

test('rejects empty parts', () => {
  assert.throws(() => buildCanonicalMessageId('slack', '', 'C', 'M'))
})

test('rejects parts containing the separator', () => {
  assert.throws(() =>
    buildCanonicalMessageId('slack', 'T:x', 'C', 'M'),
  )
})

test('rejects an unknown provider', () => {
  assert.throws(() =>
    // @ts-expect-error — exercising the runtime guard with a bad value
    buildCanonicalMessageId('teams', 'T', 'C', 'M'),
  )
})

test('parse rejects the wrong arity', () => {
  assert.throws(() => parseCanonicalMessageId('slack:T:C'))
})
