import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderMessage } from '@nessie/runtime'
import {
  MockLlmEngine,
  MockScenarioExhaustedError,
  turnIndexForMessages,
} from './engine.js'
import { loadScenario, parseScenario } from './scenario.js'

const user = (content: string): ProviderMessage => ({ content, role: 'user' })

test('turnIndexForMessages counts assistant turns', () => {
  const messages: ProviderMessage[] = [
    { content: 'sys', role: 'system' },
    user('go'),
    { content: 'working', role: 'assistant' },
    { content: 'tool result', role: 'tool', toolCallId: 'c1' },
    user('and?'),
  ]
  assert.equal(turnIndexForMessages(messages), 1)
  assert.equal(turnIndexForMessages([user('go')]), 0)
})

test('engine replays scripted turns keyed by conversation position', async () => {
  const engine = new MockLlmEngine(await loadScenario('channel-list-tool'))

  const first = await engine.next([user('what channels are there?')])
  assert.equal(first.kind, 'completion')
  assert.equal(first.turnIndex, 0)
  if (first.kind === 'completion') {
    assert.equal(first.toolCalls[0]?.toolName, 'channel_list')
  }

  const second = await engine.next([
    user('what channels are there?'),
    { content: 'working', role: 'assistant' },
    { content: '["general"]', role: 'tool', toolCallId: 'c1' },
  ])
  assert.equal(second.kind, 'completion')
  assert.equal(second.turnIndex, 1)
  if (second.kind === 'completion') {
    assert.equal(second.toolCalls.length, 0)
    assert.ok(second.text.length > 0)
  }
})

test('engine is concurrency-safe: position comes from the request, not state', async () => {
  const engine = new MockLlmEngine(await loadScenario('channel-list-tool'))
  const histories: ProviderMessage[][] = Array.from({ length: 8 }, () => [user('go')])
  const outcomes = await Promise.all(histories.map((messages) => engine.next(messages)))
  for (const outcome of outcomes) {
    assert.equal(outcome.turnIndex, 0)
  }
  assert.equal(engine.stats().requests, 8)
})

test('engine applies deterministic latency injection', async () => {
  const engine = new MockLlmEngine(
    parseScenario({ name: 'slow', turns: [{ latencyMs: 40, text: 'hi' }] }),
  )
  const startedAt = Date.now()
  await engine.next([user('go')])
  assert.ok(Date.now() - startedAt >= 35)
})

test('engine surfaces scripted failure turns as error outcomes', async () => {
  const engine = new MockLlmEngine(await loadScenario('rate-limited'))
  const outcome = await engine.next([user('go')])
  assert.equal(outcome.kind, 'error')
  if (outcome.kind === 'error') {
    assert.equal(outcome.error.status, 429)
    assert.equal(outcome.error.type, 'rate_limit_error')
  }
})

test('engine throws when the conversation outlives the script', async () => {
  const engine = new MockLlmEngine(await loadScenario('simple-answer'))
  await assert.rejects(
    engine.next([user('go'), { content: 'done', role: 'assistant' }]),
    MockScenarioExhaustedError,
  )
})
