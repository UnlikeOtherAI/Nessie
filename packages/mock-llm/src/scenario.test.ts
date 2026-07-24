import assert from 'node:assert/strict'
import test from 'node:test'

import { listScenarios, loadScenario, parseScenario } from './scenario.js'

test('bundled scenarios load and validate', async () => {
  const names = await listScenarios()
  assert.ok(names.includes('channel-list-tool'))
  assert.ok(names.includes('simple-answer'))
  assert.ok(names.includes('rate-limited'))

  for (const name of names) {
    const scenario = await loadScenario(name)
    assert.equal(scenario.name, name)
    assert.ok(scenario.turns.length >= 1)
  }
})

test('channel-list-tool scenario scripts a tool call then an answer', async () => {
  const scenario = await loadScenario('channel-list-tool')
  const [first, second] = scenario.turns
  assert.ok(first && 'toolCalls' in first)
  assert.ok(second && 'text' in second)
  if ('toolCalls' in first) {
    assert.equal(first.toolCalls[0]?.toolName, 'channel_list')
  }
  if ('text' in second) {
    assert.ok(second.text.length > 0)
  }
})

test('parseScenario rejects a scenario without turns', () => {
  assert.throws(() => parseScenario({ name: 'broken', turns: [] }))
  assert.throws(() => parseScenario({ name: 'broken' }))
})

test('parseScenario rejects an unsupported failure status', () => {
  assert.throws(() =>
    parseScenario({
      name: 'broken',
      turns: [{ error: { message: 'teapot', status: 418 } }],
    }),
  )
})

test('parseScenario defaults latency, usage, and tool-call arguments', () => {
  const scenario = parseScenario({
    name: 'defaults',
    turns: [{ text: 'hi', toolCalls: [{ toolName: 'noop' }] }],
  })
  const turn = scenario.turns[0]
  assert.ok(turn && 'toolCalls' in turn)
  if ('toolCalls' in turn) {
    assert.equal(turn.latencyMs, 0)
    assert.deepEqual(turn.toolCalls[0]?.arguments, {})
    assert.deepEqual(turn.usage, {})
  }
  assert.equal(scenario.defaults.model, 'mock-model')
})
