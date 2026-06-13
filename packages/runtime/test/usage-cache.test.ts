import assert from 'node:assert/strict'
import test from 'node:test'

import { usageFromOpenAi } from '../src/inference/connectors/openai-chat-protocol.js'
import { usageFromAnthropic } from '../src/inference/connectors/kimi-anthropic-protocol.js'

test('usageFromOpenAi splits cached tokens out of prompt_tokens', () => {
  const usage = usageFromOpenAi({
    prompt_tokens: 1000,
    completion_tokens: 50,
    total_tokens: 1050,
    prompt_tokens_details: { cached_tokens: 800 },
  })
  // OpenAI prompt_tokens INCLUDES cached, so input is the non-cached remainder.
  assert.equal(usage.inputTokens, 200)
  assert.equal(usage.cacheReadTokens, 800)
  assert.equal(usage.outputTokens, 50)
  assert.equal(usage.totalTokens, 1050)
})

test('usageFromOpenAi without cache details leaves input unchanged', () => {
  const usage = usageFromOpenAi({ prompt_tokens: 300, completion_tokens: 20 })
  assert.equal(usage.inputTokens, 300)
  assert.equal(usage.cacheReadTokens, undefined)
})

test('usageFromAnthropic keeps input separate from cache_read_input_tokens', () => {
  const usage = usageFromAnthropic({
    input_tokens: 120,
    output_tokens: 40,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 30,
  })
  // Anthropic input_tokens EXCLUDES cache reads — no subtraction.
  assert.equal(usage.inputTokens, 120)
  assert.equal(usage.cacheReadTokens, 900)
  assert.equal(usage.cacheWriteTokens, 30)
  assert.equal(usage.totalTokens, 120 + 900 + 30 + 40)
})

test('usageFromAnthropic subtracts Kimi cached_tokens subset from prompt_tokens', () => {
  const usage = usageFromAnthropic({
    prompt_tokens: 1000,
    completion_tokens: 25,
    cached_tokens: 700,
  })
  // Kimi cached_tokens is a subset of prompt_tokens — subtract it from input.
  assert.equal(usage.inputTokens, 300)
  assert.equal(usage.cacheReadTokens, 700)
  assert.equal(usage.totalTokens, 300 + 700 + 25)
})
