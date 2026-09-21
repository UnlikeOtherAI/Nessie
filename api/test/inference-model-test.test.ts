import assert from 'node:assert/strict'
import test from 'node:test'

import { ProviderHttpError } from '@nessie/runtime'

import {
  MAX_OUTPUT_TOKENS,
  runInferenceModelTest,
  TEST_PROMPT,
} from '../src/services/inference-model-test.js'

type Call = { messages: Array<{ content: string; role: string }>; options: { maxTokens?: number } }

const actorContext = {
  actionContext: { effectiveUserId: 'user-1' },
  actor: { actorId: 'user-1', actorType: 'user' },
  tenant: { organizationId: 'organization-1' },
} as never

const run = async (outcomes: Array<string | Error>) => {
  const calls: Call[] = []
  const sleeps: number[] = []
  const result = await runInferenceModelTest({
    actorContext,
    config: { apiKey: 'k', baseUrl: 'https://models.example/v1', provider: 'deepseek' } as never,
    createClient: (() => ({
      chat: async (messages: Call['messages'], options: Call['options']) => {
        calls.push({ messages, options })
        const next = outcomes.shift()
        if (next instanceof Error) throw next
        return next ?? ''
      },
      close: () => {},
    })) as never,
    ledgerIdentity: null,
    logger: { warn: () => {} },
    model: 'google/gemma-4-26b-a4b-it:free',
    prisma: {} as never,
    provider: 'openrouter',
    sleep: async (ms) => { sleeps.push(ms) },
  })
  return { calls, result, sleeps }
}

const rateLimited = () => new ProviderHttpError(
  'deepseek chat request failed with HTTP 429: Provider returned error',
  { statusCode: 429 },
)

test('the probe says "Hi" as the only message and returns the reply verbatim', async () => {
  const { calls, result } = await run(['Hello! How can I help you today?'])
  assert.equal(result.ok, true)
  assert.equal(result.reply, 'Hello! How can I help you today?')
  assert.deepEqual(calls[0]?.messages, [{ content: TEST_PROMPT, role: 'user' }])
  assert.equal(TEST_PROMPT, 'Hi')
})

test('the output cap leaves a reasoning model room to think and still answer', async () => {
  const { calls } = await run(['Hi there!'])
  assert.equal(calls[0]?.options.maxTokens, MAX_OUTPUT_TOKENS)
  assert.ok(MAX_OUTPUT_TOKENS >= 512)
})

test('one rate limit is retried and the second attempt answers', async () => {
  const { calls, result, sleeps } = await run([rateLimited(), 'Hey!'])
  assert.equal(result.ok, true)
  assert.equal(result.reply, 'Hey!')
  assert.equal(calls.length, 2)
  assert.equal(sleeps.length, 1)
})

test('a repeated rate limit names the tested provider, not the deployment connector', async () => {
  const { calls, result } = await run([rateLimited(), rateLimited()])
  assert.equal(result.ok, false)
  assert.equal(calls.length, 2)
  const message = result.failure?.message ?? ''
  assert.match(message, /rate-limiting this model/)
  assert.match(message, /openrouter chat request failed with HTTP 429: Provider returned error/)
  assert.doesNotMatch(message, /deepseek/)
})

test('a non-transient refusal is reported at once, without a retry', async () => {
  const { calls, result } = await run([
    new ProviderHttpError('deepseek chat request failed with HTTP 404: No such model', { statusCode: 404 }),
    'never reached',
  ])
  assert.equal(result.ok, false)
  assert.equal(calls.length, 1)
  assert.equal(result.failure?.message, 'openrouter chat request failed with HTTP 404: No such model')
})
