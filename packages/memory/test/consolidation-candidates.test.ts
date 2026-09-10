import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractConsolidationCandidates,
  MAX_CONSOLIDATION_CANDIDATES,
  MAX_CONSOLIDATION_MESSAGE_CHARS,
  normalizeConsolidationCandidateKey,
} from '../src/consolidation-candidates.js'

const ids = Array.from(
  { length: 6 },
  (_, index) => `00000000-0000-4000-8000-0000000000${index + 10}`,
)

const multilingual = [
  ['English', 'The launch is invite-only.', 'fact'],
  ['Czech', 'Preferuji stručné týdenní zprávy.', 'preference'],
  ['CJK', 'サポート体制が整うまで、招待制を維持してください。', 'constraint'],
  ['slang', 'pls keep updates super short rn', 'preference'],
  ['misspelling', 'rember the lauch is invite only', 'fact'],
] as const

for (const [label, content, memoryCategory] of multilingual) {
  test(`structured extraction preserves ${label} meaning and Unicode`, async () => {
    const result = await extractConsolidationCandidates({
      extract: async (input) => ({
        candidates: [{
          content: input.messages[0]!.content,
          importance: 0.8,
          memoryCategory,
          sourceMessageIds: [input.messages[0]!.id],
        }],
      }),
      messages: [{ content, id: ids[0]!, role: 'user' }],
    })

    assert.equal(result[0]?.content, content)
    assert.equal(result[0]?.memoryCategory, memoryCategory)
  })
}

test('all supplied message lineage is inherited and unavailable ids are rejected', async () => {
  const messages = [
    {
      content: 'First private source',
      id: ids[0]!,
      privateConversationSources: [{
        sourceAuthorUserId: ids[4]!,
        sourceChannelId: ids[2]!,
      }],
      role: 'user',
    },
    {
      content: 'Second private source',
      id: ids[1]!,
      privateConversationSources: [
        { sourceAuthorUserId: ids[5]!, sourceChannelId: ids[2]! },
        { sourceAuthorUserId: null, sourceChannelId: ids[3]! },
      ],
      role: 'assistant',
    },
  ]
  const result = await extractConsolidationCandidates({
    extract: async () => ({
      candidates: [{
        content: 'One conclusion from both sources',
        importance: 0.7,
        memoryCategory: 'reason',
        sourceMessageIds: [ids[1]],
      }],
    }),
    messages,
  })
  assert.deepEqual(result[0]?.privateConversationSources, [
    { sourceAuthorUserId: ids[4], sourceChannelId: ids[2] },
    { sourceAuthorUserId: ids[5], sourceChannelId: ids[2] },
    { sourceAuthorUserId: null, sourceChannelId: ids[3] },
  ])

  await assert.rejects(
    extractConsolidationCandidates({
      extract: async () => ({
        candidates: [{
          content: 'Unsupported source',
          importance: 0.5,
          memoryCategory: 'fact',
          sourceMessageIds: [ids[5]],
        }],
      }),
      messages,
    }),
    /cited unavailable source message/,
  )
})

test('input and output envelopes are bounded and malformed output fails', async () => {
  let observedLength = 0
  const result = await extractConsolidationCandidates({
    extract: async (input) => {
      observedLength = input.messages[0]!.content.length
      return { candidates: [] }
    },
    messages: [{ content: '界'.repeat(4_000), id: ids[0]!, role: 'user' }],
  })
  assert.deepEqual(result, [])
  assert.equal(observedLength, MAX_CONSOLIDATION_MESSAGE_CHARS)

  await assert.rejects(
    extractConsolidationCandidates({
      extract: async () => ({
        candidates: Array.from({ length: MAX_CONSOLIDATION_CANDIDATES + 1 }, () => ({
          content: 'too many',
          importance: 0.5,
          memoryCategory: 'fact',
          sourceMessageIds: [ids[0]],
        })),
      }),
      messages: [{ content: 'source', id: ids[0]!, role: 'user' }],
    }),
  )
  await assert.rejects(
    extractConsolidationCandidates({
      extract: async () => ({ candidates: 'malformed' }),
      messages: [{ content: 'source', id: ids[0]!, role: 'user' }],
    }),
  )
})

test('provider failures propagate for durable job retry', async () => {
  await assert.rejects(
    extractConsolidationCandidates({
      extract: async () => { throw new Error('provider unavailable') },
      messages: [{ content: 'source', id: ids[0]!, role: 'user' }],
    }),
    /provider unavailable/,
  )
})

test('candidate keys fold equivalent Unicode without deleting its identity', () => {
  const composed = 'Příliš žluťoučký kůň'
  const decomposed = composed.normalize('NFD')
  assert.equal(
    normalizeConsolidationCandidateKey(composed),
    normalizeConsolidationCandidateKey(decomposed),
  )
  assert.match(normalizeConsolidationCandidateKey(composed), /příliš/u)
})

