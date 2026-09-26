import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createLedgerDecisionClient, DecisionInputLimitError, type DecisionModelClient,
} from '../src/decision-model.js'
import type { PinnedFetch } from '../src/url-safety.js'
import { isCreditsExhaustedError } from '../src/inference/types.js'

const request = {
  state: { text: 'Maybe; let us discuss it.' },
  questions: {
    decision: {
      type: 'choice' as const, instructions: 'What is the decision status?',
      criteria: { proposed: 'Still discussing', confirmed: 'Settled', unrelated: 'No decision' },
    },
  },
  usage: {
    organizationId: 'org', actorId: 'user', actorType: 'user' as const,
    userId: 'user', teamId: 'team', requestId: 'message-123',
  },
}
const response = () => ({
  model: 'typesafe-ai/jev',
  answers: {
    decision: {
      type: 'choice', choice: 'proposed',
      probabilities: { proposed: 0.95, confirmed: 0.04, unrelated: 0.01 },
    },
  },
  usage: { inputTokens: 300, outputTokens: 32 },
})
const transport = (fetchImpl: PinnedFetch) => ({ fetchImpl, resolveHost: async () => ['8.8.8.8'] })
const base = { baseUrl: 'https://ledger.unlikeotherai.com/v1/openai', apiKey: 'synthetic-test-key' }

test('Ledger evaluation preserves enum options, signed attribution, and input/output usage', async () => {
  let metered = false
  const client = createLedgerDecisionClient({
    ...base,
    requestHeaders: async (attribution) => {
      assert.equal(attribution.actorId, 'user')
      return { 'X-Test-Provenance': 'signed' }
    },
    transport: transport(async (url, init) => {
      // Ledger's unified Vercel connector; the old `vercel-evaluate` service is gone.
      assert.equal(url.toString(), 'https://ledger.unlikeotherai.com/v1/vercel/evaluate')
      assert.equal(new Headers(init?.headers).get('X-Test-Provenance'), 'signed')
      const body = JSON.parse(init?.body as string)
      assert.deepEqual(body.questions, request.questions)
      assert.equal(body.model, 'typesafe-ai/jev')
      assert.equal(body.messages, undefined)
      assert.equal(init?.redirect, 'manual')
      return Response.json(response())
    }),
    recordUsage: async (invocations, attribution) => {
      assert.equal(invocations[0]?.provider, 'vercel')
      assert.deepEqual(invocations[0]?.usage, { inputTokens: 300, outputTokens: 32 })
      assert.equal(attribution.actorId, 'user')
      metered = true
    },
  })
  assert.equal((await client.evaluate(request)).decision?.choice, 'proposed')
  assert.equal(metered, true)
})

test('a caller that will not wait long gives up on a stalled evaluation', async () => {
  const client = createLedgerDecisionClient({
    ...base,
    transport: transport((_url, init) => new Promise<Response>((_resolve, reject) => {
      // `AbortSignal.timeout` does not hold the event loop open, and a stalled
      // fake request holds nothing either: without this the test runner sees
      // an empty loop and cancels the test before the caller's timeout fires.
      const keepAlive = setTimeout(() => undefined, 10_000)
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(keepAlive)
        reject(init.signal?.reason)
      })
    })),
  })
  const startedAt = Date.now()
  await assert.rejects(client.evaluate({ ...request, timeoutMs: 20 }))
  assert.ok(Date.now() - startedAt < 5_000, 'the caller’s own timeout applies, not the default')
})

test('Ledger credit exhaustion remains a typed refusal', async () => {
  const client = createLedgerDecisionClient({
    ...base, transport: transport(async () => Response.json({ error: { code: 'budget_exceeded' } }, { status: 402 })),
  })
  await assert.rejects(client.evaluate(request), isCreditsExhaustedError)
})

test('unknown selected enum values are refused', async () => {
  const body = response()
  body.answers.decision.choice = 'invented'
  const client = createLedgerDecisionClient({ ...base, transport: transport(async () => Response.json(body)) })
  await assert.rejects(client.evaluate(request), /outside the requested options/)
})

test('invalid probability distributions are refused', async () => {
  const body = response()
  body.answers.decision.probabilities.confirmed = 1
  const client = createLedgerDecisionClient({ ...base, transport: transport(async () => Response.json(body)) })
  await assert.rejects(client.evaluate(request), /invalid probability distribution/)
})

test('decision credentials cannot be redirected to a non-Ledger provider', () => {
  assert.throws(() => createLedgerDecisionClient({ ...base, baseUrl: 'https://api.typesafe.ai' }), /Ledger/)
})

const assertInputLimit = async (
  input: Parameters<DecisionModelClient['evaluate']>[0],
  reason: DecisionInputLimitError['reason'],
) => {
  const effects: string[] = []
  const client = createLedgerDecisionClient({
    ...base,
    requestHeaders: async () => { effects.push('sign'); return {} },
    transport: transport(async () => { effects.push('http'); return Response.json(response()) }),
    recordUsage: async () => { effects.push('usage') },
  })
  await assert.rejects(client.evaluate(input), (error: unknown) => {
    assert.ok(error instanceof DecisionInputLimitError)
    assert.equal(error.reason, reason)
    return true
  })
  assert.deepEqual(effects, [], 'Oversized input must stop before signing, HTTP, or metering')
}

test('oversized shared state plus one question is rejected before any side effect', async () => {
  await assertInputLimit({
    ...request, state: { text: 'x'.repeat(12_000) },
    questions: { decision: { ...request.questions.decision, instructions: 'y'.repeat(13_000) } },
  }, 'question_bytes')
})

test('input limits count UTF-8 JSON bytes, including multibyte text and escaping', async () => {
  for (const text of ['決'.repeat(8_000), '\n'.repeat(12_000)]) {
    await assertInputLimit({ ...request, state: { text } }, 'question_bytes')
  }
})

test('aggregate input is bounded even when each state-plus-question fits', async () => {
  await assertInputLimit({
    ...request,
    questions: Object.fromEntries(Array.from({ length: 4 }, (_, index) => [
      `q${index}`, { ...request.questions.decision, instructions: 'x'.repeat(13_000) },
    ])),
  }, 'request_bytes')
})

test('256 Choice options are rejected before signing or HTTP', async () => {
  await assertInputLimit({
    ...request,
    questions: { decision: {
      ...request.questions.decision,
      criteria: Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`o${index}`, 'An option'])),
    } },
  }, 'choice_options')
})

test('255 Choice options are forwarded intact', async () => {
  const criteria = Object.fromEntries(Array.from({ length: 255 }, (_, index) => [`o${index}`, 'An option']))
  const client = createLedgerDecisionClient({
    ...base,
    transport: transport(async (_, init) => {
      assert.deepEqual(JSON.parse(init?.body as string).questions.decision.criteria, criteria)
      return Response.json({
        ...response(),
        answers: { decision: {
          type: 'choice', choice: 'o0',
          probabilities: Object.fromEntries(Object.keys(criteria).map((key) => [key, key === 'o0' ? 1 : 0])),
        } },
      })
    }),
  })
  assert.equal((await client.evaluate({
    ...request, questions: { decision: { ...request.questions.decision, criteria } },
  })).decision?.choice, 'o0')
})
