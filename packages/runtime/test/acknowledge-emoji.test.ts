import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseAcknowledgeEmoji } from '../src/orchestrator.js'

// The value is model-authored and lands verbatim in a MessageReaction row that
// is broadcast to the whole channel — a surface nothing renders as prose, which
// is what makes it a good place to hide a sentence.

test('real emoji pass, including ZWJ sequences and skin-tone modifiers', () => {
  assert.equal(parseAcknowledgeEmoji('👍'), '👍')
  assert.equal(parseAcknowledgeEmoji('👀'), '👀')
  assert.equal(parseAcknowledgeEmoji('👍🏽'), '👍🏽')
  assert.equal(parseAcknowledgeEmoji('👨‍👩‍👧‍👦'), '👨‍👩‍👧‍👦')
  assert.equal(parseAcknowledgeEmoji('✅'), '✅')
  assert.equal(parseAcknowledgeEmoji('  🎉  '), '🎉', 'surrounding whitespace is trimmed')
})

test('prose is refused, however short', () => {
  assert.equal(parseAcknowledgeEmoji('ok'), null)
  assert.equal(parseAcknowledgeEmoji('The deal closes on the 14th.'), null)
  assert.equal(parseAcknowledgeEmoji('👍 the deal closes on the 14th'), null)
  assert.equal(parseAcknowledgeEmoji('12'), null, 'digits are emoji components but not emoji')
})

test('a long run of emoji is refused — an emoji is one token, not a payload', () => {
  assert.equal(parseAcknowledgeEmoji('👍'.repeat(20)), null)
})

test('non-strings and empties yield no reaction rather than a broken one', () => {
  assert.equal(parseAcknowledgeEmoji(undefined), null)
  assert.equal(parseAcknowledgeEmoji(null), null)
  assert.equal(parseAcknowledgeEmoji(42), null)
  assert.equal(parseAcknowledgeEmoji(''), null)
  assert.equal(parseAcknowledgeEmoji('   '), null)
})
