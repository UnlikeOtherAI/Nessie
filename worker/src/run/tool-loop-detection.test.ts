import assert from 'node:assert/strict'
import test from 'node:test'

import { executorToolName } from './executor-toolset.js'
import {
  countToolCall,
  OBSERVATION_LOOP_THRESHOLD,
  OBSERVATION_TOOL_NAMES,
  REPEATED_CALL_NUDGE,
  REPEATED_OBSERVATION_NUDGE,
  restoreLoopCounts,
  strongerNudge,
} from './tool-loop-detection.js'

const LIST = 'executor_mcp_tools'
const listKelpie = { server: 'kelpie' }

test('the third identical call of an ordinary tool is refused, whatever came between', () => {
  const counts = new Map<string, number>()
  assert.equal(countToolCall(counts, 'kb_search', { q: 'x' }), null)
  assert.equal(countToolCall(counts, 'web_fetch', { url: 'a' }), null)
  assert.equal(countToolCall(counts, 'kb_search', { q: 'x' }), null)
  assert.equal(countToolCall(counts, 'web_fetch', { url: 'b' }), null)
  assert.equal(countToolCall(counts, 'kb_search', { q: 'x' })?.nudge, REPEATED_CALL_NUDGE)
})

test('an observation tool is refused only on the fourth identical call in a row', () => {
  const counts = new Map<string, number>()
  for (let call = 1; call < OBSERVATION_LOOP_THRESHOLD; call += 1) {
    assert.equal(countToolCall(counts, LIST, listKelpie), null, `call ${call} in a row is allowed`)
  }
  const verdict = countToolCall(counts, LIST, listKelpie)
  assert.equal(verdict?.nudge, REPEATED_OBSERVATION_NUDGE)
  assert.match(verdict?.output ?? '', /3 times in a row/)
  // The streak goes on refusing until something else is called.
  assert.equal(countToolCall(counts, LIST, listKelpie)?.nudge, REPEATED_OBSERVATION_NUDGE)
})

test('any other call resets an observation streak', () => {
  const counts = new Map<string, number>()
  for (let round = 0; round < 5; round += 1) {
    for (let call = 1; call < OBSERVATION_LOOP_THRESHOLD; call += 1) {
      assert.equal(countToolCall(counts, LIST, listKelpie), null)
    }
    // A different call — here the same tool with other arguments — in between.
    assert.equal(countToolCall(counts, LIST, { server: 'ollama-search' }), null)
  }
  // Observation calls are also exempt from the cumulative rule: fifteen
  // identical listings across the run, none refused.
})

test('an ordinary call between observations resets the streak too', () => {
  const counts = new Map<string, number>()
  countToolCall(counts, LIST, listKelpie)
  countToolCall(counts, LIST, listKelpie)
  countToolCall(counts, LIST, listKelpie)
  countToolCall(counts, 'executor_mcp_call', { server: 'kelpie', tool: 'navigate' })
  assert.equal(countToolCall(counts, LIST, listKelpie), null)
  assert.equal(
    [...counts.keys()].filter((key) => key.includes(LIST)).length,
    1,
    'only the live streak is kept in the checkpointed counts',
  )
})

test('counts from before the observation rule are dropped on resume', () => {
  const restored = restoreLoopCounts({
    // Written by the previous rule: name and arguments, no prefix.
    [`kb_search:${JSON.stringify({ q: 'x' })}`]: 2,
    [`${LIST}:${JSON.stringify(listKelpie)}`]: 2,
  })
  assert.equal(restored.size, 0)
  // So the next identical call is the first under the new keys, not the third.
  assert.equal(countToolCall(restored, 'kb_search', { q: 'x' }), null)
})

test('counts written under the current rule survive a resume', () => {
  const counts = new Map<string, number>()
  countToolCall(counts, 'kb_search', { q: 'x' })
  countToolCall(counts, 'kb_search', { q: 'x' })
  const restored = restoreLoopCounts(Object.fromEntries(counts))
  assert.equal(countToolCall(restored, 'kb_search', { q: 'x' })?.nudge, REPEATED_CALL_NUDGE)
  assert.deepEqual(restoreLoopCounts(undefined), new Map())
})

test('the observation set names the executor listing tool by its real wire name', () => {
  assert.equal(OBSERVATION_TOOL_NAMES.has(executorToolName('mcp.tools')), true)
  assert.equal(OBSERVATION_TOOL_NAMES.has(executorToolName('mcp.call')), false)
})

test('a plain repeat outranks a repeated observation in the one nudge a batch gets', () => {
  const repeat = { nudge: REPEATED_CALL_NUDGE, output: '' }
  const observation = { nudge: REPEATED_OBSERVATION_NUDGE, output: '' }
  assert.equal(strongerNudge(null, observation), REPEATED_OBSERVATION_NUDGE)
  assert.equal(strongerNudge(REPEATED_OBSERVATION_NUDGE, repeat), REPEATED_CALL_NUDGE)
  assert.equal(strongerNudge(REPEATED_CALL_NUDGE, observation), REPEATED_CALL_NUDGE)
})
