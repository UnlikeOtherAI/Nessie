import assert from 'node:assert/strict'
import test from 'node:test'
import type { DecisionModelClient } from '@nessie/runtime'
import type { Pool } from 'pg'

import { captureThought } from '../src/capture.js'
import {
  CONSOLIDATION_GATE_MINIMUM_PROBABILITY,
  gateCandidateExtraction,
  gateExtraction,
} from '../src/extraction-gate.js'

/**
 * Jev is a stub: these pin which generative extraction a capture still pays
 * for once Jev has answered. The texts are Czech and slang on purpose — the
 * code never reads them.
 */

const usage = { organizationId: 'org' }

const jev = (answers: Record<string, [string, number]>): DecisionModelClient => ({
  evaluate: async (input) => Object.fromEntries(Object.entries(input.questions).map(([id, question]) => {
    const [choice, probability] = answers[id] ?? [Object.keys(question.criteria)[0]!, 0.3]
    return [id, { type: 'choice' as const, choice, probabilities: { [choice]: probability } }]
  })),
})

test('a sure "nothing to index" stores metadata of its kind without generating it', async () => {
  const gate = await gateExtraction(
    jev({ substance: ['filler', 0.93], kind: ['observation', 0.85], reasoning: ['absent', 0.97] }),
    'jj díky, mrknu', usage,
  )
  assert.deepEqual(gate, {
    metadata: { people: [], topics: [], type: 'observation', actionItems: [], dates: [] },
    skipReasoning: true,
  })
})

test('an unsure kind is a note, and only a sure answer skips anything', async () => {
  const filler = await gateExtraction(jev({ substance: ['filler', 0.9], kind: ['task', 0.4] }), 'ok', usage)
  assert.equal(filler?.metadata?.type, 'note')
  assert.equal(filler?.skipReasoning, false)

  const unsure = await gateExtraction(
    jev({ substance: ['filler', 0.7], reasoning: ['absent', 0.6] }), 'hmm tak jo', usage,
  )
  assert.deepEqual(unsure, { metadata: null, skipReasoning: false })

  const substantive = await gateExtraction(
    jev({ substance: ['substantive', 0.95], reasoning: ['present', 0.9] }),
    'bereme Postgres, protože Mongo nemá transakce přes kolekce', usage,
  )
  assert.deepEqual(substantive, { metadata: null, skipReasoning: false })
})

test('a failing gate extracts as before', async () => {
  const failing: DecisionModelClient = { evaluate: async () => { throw new Error('ledger down') } }
  assert.equal(await gateExtraction(failing, 'cokoli', usage), null)
})

const pool = (): Pool => {
  const query = async (sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
    if (sql.includes('SELECT id, metadata FROM thoughts')) return { rows: [] }
    if (sql.includes('INSERT INTO thoughts')) {
      return { rows: [{ created_at: '2026-09-26T12:00:00.000Z', id: '44444444-4444-4444-4444-444444444444' }] }
    }
    return { rowCount: 1, rows: [] }
  }
  return { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool
}

const capture = async (decisionClient?: DecisionModelClient) => {
  const prompts: string[] = []
  const result = await captureThought(
    {
      content: 'super, díky moc!!',
      organizationId: '33333333-3333-3333-3333-333333333333',
      ownerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      ownerType: 'user',
      userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      visibility: 'private',
    },
    {
      modelClient: {
        chatJson: async (messages: Array<{ content: string }>) => {
          prompts.push(messages[0]!.content)
          return {}
        },
        embed: async () => [0.1, 0.2, 0.3],
      } as never,
      pool: pool(),
      ...(decisionClient ? { decisionClient } : {}),
    },
  )
  return { prompts, result }
}

test('a capture Jev is sure about makes no generative extraction at all', async () => {
  const { prompts, result } = await capture(
    jev({ substance: ['filler', 0.95], kind: ['note', 0.9], reasoning: ['absent', 0.95] }),
  )
  assert.deepEqual(prompts, [])
  assert.equal(result.metadata?.type, 'note')
  assert.equal(result.memoryCategory, 'fact')
})

test('without Jev, or when it is unsure, both extractions still run', async () => {
  assert.equal((await capture()).prompts.length, 2)
  assert.equal((await capture(jev({}))).prompts.length, 2)
})

const conversation = {
  messages: [
    { id: 'm1', role: 'user' as const, content: 'jaký je kurz eura?' },
    { id: 'm2', role: 'assistant' as const, content: 'Dnes 24,31 Kč za euro.' },
  ],
}

const counting = () => {
  let calls = 0
  const extract = async () => {
    calls += 1
    return { candidates: [] }
  }
  return { calls: () => calls, extract }
}

test('a run Jev is sure left nothing durable skips its memory extraction', async () => {
  const model = counting()
  const gated = gateCandidateExtraction(
    jev({ durable: ['nothing', CONSOLIDATION_GATE_MINIMUM_PROBABILITY] }), usage, model.extract,
  )
  assert.deepEqual(await gated(conversation), { candidates: [] })
  assert.equal(model.calls(), 0)
})

test('doubt, something durable, a long conversation, a failure or no Jev extract as before', async () => {
  for (const client of [
    jev({ durable: ['nothing', 0.85] }),
    jev({ durable: ['durable', 0.99] }),
    { evaluate: async () => { throw new Error('ledger down') } } as DecisionModelClient,
  ]) {
    const model = counting()
    await gateCandidateExtraction(client, usage, model.extract)(conversation)
    assert.equal(model.calls(), 1)
  }

  const long = { messages: Array.from({ length: 20 }, (_, index) => ({
    id: `m${index}`, role: 'user' as const, content: 'x'.repeat(2_000),
  })) }
  const asked: unknown[] = []
  const model = counting()
  await gateCandidateExtraction({
    evaluate: async (input) => { asked.push(input); return {} },
  }, usage, model.extract)(long)
  assert.deepEqual(asked, [], 'a conversation Jev cannot read whole is not judged')
  assert.equal(model.calls(), 1)

  const noJev = counting()
  assert.equal(gateCandidateExtraction(undefined, usage, noJev.extract), noJev.extract)
})
