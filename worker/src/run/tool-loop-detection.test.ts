import assert from 'node:assert/strict'
import test from 'node:test'

import { ToolCircuitBreaker } from './circuit-breaker.js'
import { CODING_SESSION_TOOL_NAME_SET, CODING_SESSION_TOOL_NAMES } from './coding-session-tools.js'
import { executorToolName } from './executor-toolset.js'
import { executeToolBatch } from './tool-batch.js'
import {
  CODING_NO_PROGRESS_NUDGE,
  CODING_OBSERVATION_TOOL_NAMES,
  countToolCall,
  noteWatchProgress,
  OBSERVATION_LOOP_THRESHOLD,
  OBSERVATION_TOOL_NAMES,
  REPEATED_CALL_NUDGE,
  REPEATED_OBSERVATION_NUDGE,
  restoreLoopCounts,
  strongerNudge,
  WATCH_TOOL_NAMES,
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

test('the coding observation tools are the coding-session tools that only look', () => {
  for (const name of CODING_OBSERVATION_TOOL_NAMES) {
    assert.ok(CODING_SESSION_TOOL_NAME_SET.has(name), `${name} is a coding-session tool`)
    assert.ok(OBSERVATION_TOOL_NAMES.has(name), `${name} is an observation tool`)
  }
  assert.deepEqual([...CODING_OBSERVATION_TOOL_NAMES].sort(), [
    CODING_SESSION_TOOL_NAMES.list, CODING_SESSION_TOOL_NAMES.review, CODING_SESSION_TOOL_NAMES.wait,
  ].sort())
  const acting = [CODING_SESSION_TOOL_NAMES.start, CODING_SESSION_TOOL_NAMES.send, CODING_SESSION_TOOL_NAMES.close]
  for (const name of acting) {
    assert.equal(OBSERVATION_TOOL_NAMES.has(name), false, `${name} acts, so the cumulative rule keeps it`)
  }
})

test('listing or reviewing a coding session four times in a row is refused with the coding nudge', () => {
  const counts = new Map<string, number>()
  const review = { sessionId: 'a' }
  for (let call = 1; call < OBSERVATION_LOOP_THRESHOLD; call += 1) {
    assert.equal(countToolCall(counts, CODING_SESSION_TOOL_NAMES.review, review), null)
  }
  const verdict = countToolCall(counts, CODING_SESSION_TOOL_NAMES.review, review)
  assert.equal(verdict?.nudge, CODING_NO_PROGRESS_NUDGE)
  assert.equal(
    CODING_NO_PROGRESS_NUDGE,
    'The coding agent is still working; that is normal. Wait again, or tell the person where things stand and end your turn.',
  )
})

test('a wait is never refused before it runs, however often it is repeated', () => {
  const counts = new Map<string, number>()
  for (let call = 0; call < 20; call += 1) {
    assert.equal(countToolCall(counts, CODING_SESSION_TOOL_NAMES.wait, { sessionId: 'a' }), null)
  }
})

test('the third wait in a row that saw nothing move earns the nudge, and progress restarts the count', () => {
  const counts = new Map<string, number>()
  const wait = CODING_SESSION_TOOL_NAMES.wait
  const args = { sessionId: 'a' }
  const look = (progressed: boolean): string | null => {
    countToolCall(counts, wait, args)
    return noteWatchProgress(counts, wait, args, progressed)
  }
  assert.equal(look(false), null)
  assert.equal(look(false), null)
  assert.equal(look(true), null, 'a wait that saw progress restarts the count')
  assert.equal(look(false), null)
  assert.equal(look(false), null)
  assert.equal(look(false), CODING_NO_PROGRESS_NUDGE)
  assert.equal(look(false), null, 'the nudge restarts the count too')
  // Another call in between ends the streak.
  look(false)
  countToolCall(counts, CODING_SESSION_TOOL_NAMES.review, args)
  assert.equal(look(false), null)
  assert.equal(noteWatchProgress(counts, 'kb_search', {}, false), null, 'only a watch tool reports progress')
  assert.ok(WATCH_TOOL_NAMES.has(wait))
})

test('a batch turns a stalled wait’s report into the loop nudge, and a wait that moved into none', async () => {
  const counts = new Map<string, number>()
  const run = (watchProgressed: boolean) => executeToolBatch({
    callbacks: { onToolCallEnd: async () => undefined, onToolCallStart: async () => undefined },
    circuitBreaker: new ToolCircuitBreaker(),
    executeTool: async () => ({ inputSummary: '', output: 'still working', success: true, watchProgressed }),
    signatureCounts: counts,
    toolCalls: [{ arguments: { sessionId: 'a' }, toolCallId: `w-${counts.size}-${Math.random()}`, toolName: CODING_SESSION_TOOL_NAMES.wait }],
  })
  assert.equal((await run(false)).loopNudge, null)
  assert.equal((await run(false)).loopNudge, null)
  assert.equal((await run(false)).loopNudge, CODING_NO_PROGRESS_NUDGE)
  assert.equal((await run(true)).loopNudge, null)
})
