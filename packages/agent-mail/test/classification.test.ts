import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyInboundEmail,
  shouldWakeAgent,
  verdictsBlockAutonomy,
} from '../src/classification.js'

const headers = (values: Record<string, string>) => (name: string) => values[name.toLowerCase()]

test('an ordinary person-to-person message is normal and wakes the agent', () => {
  const classification = classifyInboundEmail({ header: headers({}) })
  assert.equal(classification, 'normal')
  assert.equal(shouldWakeAgent({ classification }), true)
})

test('a null return-path is a delivery report and never wakes the agent', () => {
  assert.equal(classifyInboundEmail({ envelopeFrom: '', header: headers({}) }), 'dsn')
  assert.equal(classifyInboundEmail({ envelopeFrom: '<>', header: headers({}) }), 'dsn')
  assert.equal(classifyInboundEmail({ header: headers({ 'return-path': '<>' }) }), 'dsn')
  assert.equal(shouldWakeAgent({ classification: 'dsn' }), false)
})

test('a multipart/report delivery status is a dsn', () => {
  const classification = classifyInboundEmail({
    contentType: 'multipart/report; report-type=delivery-status; boundary=x',
    header: headers({}),
  })
  assert.equal(classification, 'dsn')
})

test('Auto-Submitted other than "no" marks automated mail as bulk', () => {
  assert.equal(classifyInboundEmail({ header: headers({ 'auto-submitted': 'auto-generated' }) }), 'bulk')
  assert.equal(classifyInboundEmail({ header: headers({ 'auto-submitted': 'no' }) }), 'normal')
})

test('an auto-reply is a dsn, so two agents cannot ping-pong forever', () => {
  assert.equal(classifyInboundEmail({ header: headers({ 'auto-submitted': 'auto-replied' }) }), 'dsn')
})

test('mailing-list headers mark bulk mail', () => {
  assert.equal(classifyInboundEmail({ header: headers({ 'list-id': '<dev.example.com>' }) }), 'bulk')
  assert.equal(
    classifyInboundEmail({ header: headers({ 'list-unsubscribe': '<https://x/u>' }) }),
    'bulk',
  )
  assert.equal(classifyInboundEmail({ header: headers({ precedence: 'bulk' }) }), 'bulk')
  assert.equal(classifyInboundEmail({ header: headers({ precedence: 'list' }) }), 'bulk')
})

test('classification reads headers only — wording never changes the verdict', () => {
  // The same body text under no automation headers stays `normal` in any
  // language. Meaning is the model's job; this layer only reads RFC facts.
  for (const subject of ['URGENT: reply now', 'Nevyžádaná pošta', '緊急のお知らせ', 'oferta!!!']) {
    assert.equal(classifyInboundEmail({ header: headers({ subject }) }), 'normal')
  }
})

test('a failed spam, virus or auth verdict blocks autonomy without discarding the mail', () => {
  assert.equal(verdictsBlockAutonomy({ spam: 'FAIL' }), true)
  assert.equal(verdictsBlockAutonomy({ virus: 'FAIL' }), true)
  assert.equal(verdictsBlockAutonomy({ dmarc: 'FAIL' }), true)
  assert.equal(verdictsBlockAutonomy({ spf: 'SOFTFAIL' }), true)
  assert.equal(verdictsBlockAutonomy({ dkim: 'PASS', spam: 'PASS' }), false)
  assert.equal(verdictsBlockAutonomy(null), false)
  assert.equal(
    shouldWakeAgent({ classification: 'normal', verdicts: { virus: 'FAIL' } }),
    false,
  )
})
