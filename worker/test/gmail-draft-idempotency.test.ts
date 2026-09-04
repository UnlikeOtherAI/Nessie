import assert from 'node:assert/strict'
import test from 'node:test'

import { gmailDraftCreateIdempotencyKey } from '../src/run/pa-tools/gmail-tools.js'

const context = (toolCallId: string | null) => ({
  run: { id: '00000000-0000-4000-8000-000000000001' },
  toolCallId,
})

test('Gmail draft create uses the durable run and provider tool-call identity', () => {
  const first = gmailDraftCreateIdempotencyKey(context('provider-call-1'), { body: 'first', to: ['a@example.test'] })
  const replay = gmailDraftCreateIdempotencyKey(context('provider-call-1'), { body: 'first', to: ['a@example.test'] })
  const anotherCall = gmailDraftCreateIdempotencyKey(context('provider-call-2'), { body: 'first', to: ['a@example.test'] })
  assert.equal(replay, first)
  assert.notEqual(anotherCall, first)
  assert.equal(first, 'gmail-draft:00000000-0000-4000-8000-000000000001:provider-call-1')
})

test('Gmail draft create has a deterministic recovered identity when a provider omitted one', () => {
  const first = gmailDraftCreateIdempotencyKey(context(null), { body: 'first', to: ['a@example.test'] })
  const replay = gmailDraftCreateIdempotencyKey(context(null), { body: 'first', to: ['a@example.test'] })
  assert.equal(replay, first)
  assert.match(first, /^gmail-draft:00000000-0000-4000-8000-000000000001:recovered:[a-f0-9]{64}$/)
})
