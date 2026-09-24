import assert from 'node:assert/strict'
import test from 'node:test'

import { DeepWaterBriefInputSchema, deepWaterScopeStartLedgerArgs } from '../index.js'

/**
 * The one builder of a brief's `research_scope_start` arguments: the opening
 * call and every replay of it send exactly this, so Ledger's fingerprint of the
 * replay always matches the call that opened the brief.
 */

const stored = (overrides: Record<string, unknown> = {}) => DeepWaterBriefInputSchema.parse({
  schemaVersion: 1,
  topic: 'Heat pumps in older houses',
  context: null,
  pillars: null,
  settings: null,
  originRootMessageId: null,
  ...overrides,
})

test('only what the brief was opened with is sent, in Ledger\'s own words', () => {
  assert.deepEqual(deepWaterScopeStartLedgerArgs(stored()), { topic: 'Heat pumps in older houses' })
  assert.deepEqual(
    deepWaterScopeStartLedgerArgs(stored({
      context: 'Solid brick.',
      pillars: ['Costs'],
      settings: { outputLanguage: 'cs', depth: 'heavy' },
    })),
    {
      topic: 'Heat pumps in older houses',
      context: 'Solid brick.',
      pillars: ['Costs'],
      settings: { depth: 'heavy', output_language: 'cs' },
    },
  )
  // No background is no background, as Ledger treats it.
  assert.deepEqual(deepWaterScopeStartLedgerArgs(stored({ context: '' })), { topic: 'Heat pumps in older houses' })
})

test('the same stored brief always builds byte-identical arguments', () => {
  const input = stored({ settings: { languages: ['en', 'cs'], writingStyle: 'scientific', depth: 'deep' } })
  const first = JSON.stringify(deepWaterScopeStartLedgerArgs(input))
  const reread = DeepWaterBriefInputSchema.parse(JSON.parse(JSON.stringify(input)))
  const replay = JSON.stringify(deepWaterScopeStartLedgerArgs(reread))
  assert.equal(replay, first)
})
