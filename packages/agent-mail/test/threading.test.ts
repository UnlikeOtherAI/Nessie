import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeMessageId, parseReferences } from '../src/address.js'
import { resolveInboundThreading } from '../src/threading.js'

const candidates = [
  { conversationId: 'conv-a', rfcMessageId: 'a1@example.com' },
  { conversationId: 'conv-b', rfcMessageId: 'b1@example.com' },
  { conversationId: 'conv-b', rfcMessageId: 'b2@example.com' },
]

test('In-Reply-To joins the conversation it names', () => {
  const decision = resolveInboundThreading({
    candidates,
    inReplyTo: 'b2@example.com',
    references: [],
  })
  assert.deepEqual(decision, { conversationId: 'conv-b', kind: 'existing', matchedOn: 'in_reply_to' })
})

test('References falls back to the nearest recognised ancestor, newest first', () => {
  const decision = resolveInboundThreading({
    candidates,
    inReplyTo: 'unknown@elsewhere.example',
    references: ['a1@example.com', 'b1@example.com'],
  })
  assert.equal(decision.kind, 'existing')
  assert.equal(decision.kind === 'existing' && decision.conversationId, 'conv-b')
  assert.equal(decision.kind === 'existing' && decision.matchedOn, 'references')
})

test('a missing Message-ID starts a new conversation rather than dropping the mail', () => {
  const decision = resolveInboundThreading({ candidates, inReplyTo: null, references: [] })
  assert.deepEqual(decision, { kind: 'new' })
})

test('a forged reference to an id this mailbox never saw starts a new conversation', () => {
  // The candidate set is already scoped to one mailbox, so a crafted header
  // naming another tenant's message id matches nothing.
  const decision = resolveInboundThreading({
    candidates,
    inReplyTo: 'victim-thread@other-tenant.example',
    references: ['another@other-tenant.example'],
  })
  assert.deepEqual(decision, { kind: 'new' })
})

test('a duplicated Message-ID keeps the older conversation instead of being stolen', () => {
  const duplicated = [
    { conversationId: 'conv-old', rfcMessageId: 'dup@example.com' },
    { conversationId: 'conv-new', rfcMessageId: 'dup@example.com' },
  ]
  const decision = resolveInboundThreading({
    candidates: duplicated,
    inReplyTo: 'dup@example.com',
    references: [],
  })
  assert.equal(decision.kind === 'existing' && decision.conversationId, 'conv-old')
})

test('an empty mailbox always starts a new conversation', () => {
  assert.deepEqual(
    resolveInboundThreading({ candidates: [], inReplyTo: 'x@y', references: ['a@b'] }),
    { kind: 'new' },
  )
})

test('message ids normalize away angle brackets and case before comparison', () => {
  assert.equal(normalizeMessageId('<ABC@Example.COM>'), 'abc@example.com')
  assert.equal(normalizeMessageId('  '), null)
  assert.equal(normalizeMessageId(undefined), null)
  assert.deepEqual(parseReferences('<a@x> <B@Y>'), ['a@x', 'b@y'])
  assert.deepEqual(parseReferences(null), [])
})
