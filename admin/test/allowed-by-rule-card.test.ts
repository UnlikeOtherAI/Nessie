import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

// The receipt for an action a standing rule let through. A rule that silences
// the prompt must not silence the fact.
test('the allowed-by-rule receipt needs a headline to render at all', async () => {
  const { readAllowedByRule } = await import(
    '../src/components/features/channels/AllowedByRuleCard.js'
  )
  assert.deepEqual(
    readAllowedByRule({
      card: {
        kind: 'allowed_by_rule',
        headline: 'Create “Sprint review”',
        audience: '3 guests will be emailed',
        details: 'title=Sprint review',
        rule: 'Scheduling only.',
      },
    }),
    {
      headline: 'Create “Sprint review”',
      audience: '3 guests will be emailed',
      details: 'title=Sprint review',
      rule: 'Scheduling only.',
    },
  )
  // No headline means nothing describable happened, so nothing is claimed.
  assert.equal(readAllowedByRule({ card: { kind: 'allowed_by_rule' } }), null)
  assert.equal(readAllowedByRule({ card: { kind: 'gmail_draft' } }), null)
})

test('a receipt with no written rule still renders, without inventing one', async () => {
  const { readAllowedByRule } = await import(
    '../src/components/features/channels/AllowedByRuleCard.js'
  )
  const card = readAllowedByRule({
    card: { kind: 'allowed_by_rule', headline: 'Create an event' },
  })
  assert.equal(card?.rule, null)
  assert.equal(card?.headline, 'Create an event')
})
