import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderToolCall } from '@nessie/runtime'

import { circuitBreakerKey, ToolCircuitBreaker } from './circuit-breaker.js'
import { executeToolBatch, type ExecutedToolResult } from './tool-batch.js'

/**
 * Failure accounting in the batch: what the circuit breaker counts, and under
 * which key. Every run once shared one breaker count for all of
 * `executor_mcp_call`, so three failures of one browser tool disabled every
 * program on the machine — and a malformed argument counted as a failure of
 * the program.
 */

const noopCallbacks = {
  onToolCallEnd: async () => undefined,
  onToolCallStart: async () => undefined,
}

let callNumber = 0
const mcpCall = (server: string, tool: string): ProviderToolCall => {
  callNumber += 1
  // Distinct inner arguments, so the loop detector never has a say.
  return {
    arguments: { arguments: { attempt: callNumber }, server, tool },
    toolCallId: `call-${callNumber}`,
    toolName: 'executor_mcp_call',
  }
}

const runOne = async (
  circuitBreaker: ToolCircuitBreaker,
  toolCall: ProviderToolCall,
  result: ExecutedToolResult,
): Promise<{ dispatched: boolean; result: ExecutedToolResult | undefined }> => {
  let dispatched = false
  const batch = await executeToolBatch({
    callbacks: noopCallbacks,
    circuitBreaker,
    executeTool: async () => {
      dispatched = true
      return result
    },
    signatureCounts: new Map(),
    toolCalls: [toolCall],
  })
  return { dispatched, result: batch.results[0] }
}

const failure: ExecutedToolResult = { inputSummary: 'call', output: '{"success":false}', success: false }
const correctable: ExecutedToolResult = { ...failure, correctable: true }

test('three failures of one program tool disable that tool, not the program or its neighbours', async () => {
  const breaker = new ToolCircuitBreaker()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await runOne(breaker, mcpCall('kelpie', 'wait_for_element'), failure)
  }

  const refused = await runOne(breaker, mcpCall('kelpie', 'wait_for_element'), failure)
  assert.equal(refused.dispatched, false)
  assert.match(refused.result?.output ?? '', /executor_mcp_call:kelpie:wait_for_element" disabled after 3/)

  const sibling = await runOne(breaker, mcpCall('kelpie', 'navigate'), { ...failure, success: true })
  assert.equal(sibling.dispatched, true, 'another tool of the same program still runs')
  const otherProgram = await runOne(breaker, mcpCall('coding-sessions', 'start'), { ...failure, success: true })
  assert.equal(otherProgram.dispatched, true, 'another program still runs')
})

test('correctable failures reach the model and never trip the breaker', async () => {
  const breaker = new ToolCircuitBreaker()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const outcome = await runOne(breaker, mcpCall('kelpie', 'navigate'), correctable)
    assert.equal(outcome.dispatched, true)
    assert.equal(outcome.result?.success, false, 'the model still sees the failure')
  }
  assert.deepEqual(breaker.snapshot(), {})
})

test('a correctable failure neither counts nor clears the real failures around it', async () => {
  const breaker = new ToolCircuitBreaker()
  const key = circuitBreakerKey('executor_mcp_call', { server: 'kelpie', tool: 'navigate' })
  await runOne(breaker, mcpCall('kelpie', 'navigate'), failure)
  await runOne(breaker, mcpCall('kelpie', 'navigate'), failure)
  await runOne(breaker, mcpCall('kelpie', 'navigate'), correctable)
  assert.equal(breaker.snapshot()[key], 2)
  await runOne(breaker, mcpCall('kelpie', 'navigate'), failure)
  assert.equal(breaker.isTripped(key), true)
})

test('a thrown error still counts under the per-tool key', async () => {
  const breaker = new ToolCircuitBreaker()
  const batch = await executeToolBatch({
    callbacks: noopCallbacks,
    circuitBreaker: breaker,
    executeTool: async () => { throw new Error('socket closed') },
    signatureCounts: new Map(),
    toolCalls: [mcpCall('kelpie', 'screenshot')],
  })
  assert.equal(batch.results[0]?.success, false)
  assert.deepEqual(breaker.snapshot(), { 'executor_mcp_call:kelpie:screenshot': 1 })
})

// A Meta or legacy OpenAI model calls `default.<tool>` / `functions.<tool>`;
// the loop drops the prefix for dispatch, and the counts must follow it.
const withoutPrefix = (toolName: string): string => toolName.replace(/^(default|functions)\./, '')

test('a prefixed call is counted under the program tool it reaches', async () => {
  const breaker = new ToolCircuitBreaker()
  const prefixed = (server: string, tool: string): ProviderToolCall => {
    const call = mcpCall(server, tool)
    return { ...call, toolName: `default.${call.toolName}` }
  }
  const runPrefixed = async (toolCall: ProviderToolCall, result: ExecutedToolResult) => {
    let dispatched = false
    await executeToolBatch({
      callbacks: noopCallbacks,
      circuitBreaker: breaker,
      executeTool: async () => {
        dispatched = true
        return result
      },
      normalizeToolName: withoutPrefix,
      signatureCounts: new Map(),
      toolCalls: [toolCall],
    })
    return dispatched
  }
  for (let attempt = 0; attempt < 3; attempt += 1) await runPrefixed(prefixed('kelpie', 'wait_for_element'), failure)
  assert.equal(breaker.isTripped('executor_mcp_call:kelpie:wait_for_element'), true)
  assert.equal(await runPrefixed(prefixed('kelpie', 'wait_for_element'), failure), false)
  assert.equal(
    await runPrefixed(prefixed('coding-sessions', 'start'), { ...failure, success: true }),
    true,
    'one flaky tool no longer disables every program',
  )
})

test('three failed listings of one program leave the others listable', async () => {
  const breaker = new ToolCircuitBreaker()
  const listing = (server: string): ProviderToolCall => {
    callNumber += 1
    return { arguments: { server }, toolCallId: `call-${callNumber}`, toolName: 'executor_mcp_tools' }
  }
  const unavailable: ExecutedToolResult = { inputSummary: 'list', output: 'EXECUTOR_MCP_UNAVAILABLE', success: false }
  // Each in its own batch with fresh loop counts: this is about the breaker.
  for (let attempt = 0; attempt < 3; attempt += 1) await runOne(breaker, listing('kelpie'), unavailable)
  assert.equal((await runOne(breaker, listing('kelpie'), unavailable)).dispatched, false)
  const other = await runOne(breaker, listing('ollama-search'), { ...unavailable, success: true })
  assert.equal(other.dispatched, true)
})

test('a prefixed listing gets the observation loop rule, not the cumulative one', async () => {
  const counts = new Map<string, number>()
  const refused: boolean[] = []
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let dispatched = false
    await executeToolBatch({
      callbacks: noopCallbacks,
      circuitBreaker: new ToolCircuitBreaker(),
      executeTool: async () => {
        dispatched = true
        return { inputSummary: 'list', output: 'tools', success: true }
      },
      normalizeToolName: withoutPrefix,
      signatureCounts: counts,
      toolCalls: [{ arguments: { server: 'kelpie' }, toolCallId: `list-${attempt}`, toolName: 'default.executor_mcp_tools' }],
    })
    refused.push(!dispatched)
  }
  // The cumulative rule would refuse the third; an observation is refused on
  // the fourth in a row.
  assert.deepEqual(refused, [false, false, false, true])
})
