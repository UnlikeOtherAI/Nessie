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
