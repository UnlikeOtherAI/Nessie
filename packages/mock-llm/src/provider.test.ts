import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderMessage } from '@nessie/runtime'
import { MockLlmProviderError } from './engine.js'
import { createMockRunInference } from './provider.js'
import { loadScenario } from './scenario.js'

const user = (content: string): ProviderMessage => ({ content, role: 'user' })

test('mock runInference returns a loop-shaped InferenceResult', async () => {
  const runInference = createMockRunInference(await loadScenario('simple-answer'))
  const result = await runInference([user('hello')])

  assert.equal(result.provider, 'openai')
  assert.equal(result.model, 'mock-model')
  assert.equal(result.finishReason, 'stop')
  assert.ok(result.outputText.length > 0)
  assert.deepEqual(result.toolCalls, [])
  assert.equal(result.invocations.length, 1)
  assert.equal(result.invocations[0]?.operationType, 'chat')
  assert.equal(
    result.invocations[0]?.usage.totalTokens,
    (result.invocations[0]?.usage.inputTokens ?? 0)
    + (result.invocations[0]?.usage.outputTokens ?? 0),
  )
})

test('tool-call turns carry provider tool calls and a tool-call finish reason', async () => {
  const runInference = createMockRunInference(await loadScenario('channel-list-tool'))
  const result = await runInference([user('channels?')])

  assert.equal(result.finishReason, 'tool-call')
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0]?.toolName, 'channel_list')
  assert.deepEqual(result.toolCalls[0]?.arguments, { limit: 5 })
  assert.equal(result.toolCalls[0]?.toolCallId, 'mock-call-channel-list-1')
})

test('scripted failure turns throw a status-shaped provider error', async () => {
  const runInference = createMockRunInference(await loadScenario('rate-limited'))
  await assert.rejects(runInference([user('go')]), (error: unknown) => {
    assert.ok(error instanceof MockLlmProviderError)
    assert.equal(error.status, 429)
    assert.equal(error.code, 'rate_limit_exceeded')
    return true
  })
})

test('replay is deterministic across independent adapters', async () => {
  const scenario = await loadScenario('channel-list-tool')
  const first = createMockRunInference(scenario)
  const second = createMockRunInference(scenario)

  const history: ProviderMessage[] = [user('channels?')]
  const firstTurnA = await first(history)
  const firstTurnB = await second(history)
  assert.deepEqual(firstTurnA.toolCalls, firstTurnB.toolCalls)
  assert.equal(firstTurnA.outputText, firstTurnB.outputText)
})
