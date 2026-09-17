import assert from 'node:assert/strict'
import test from 'node:test'

import { ToolCircuitBreaker } from './circuit-breaker.js'
import { executeToolBatch } from './tool-batch.js'

/**
 * Tool-call timeouts must CANCEL the in-flight call, not merely out-race it.
 *
 * The batch used to wrap each execution in a bare `Promise.race`: the loop
 * got its timeout verdict, but the losing promise kept running — a provider
 * that accepted the connection and then stalled held its socket against the
 * worker's pool, and a mutating Gmail/Calendar call the loop went on to
 * retry could still complete underneath the retry. These tests pin the fix:
 * every call gets an AbortSignal, and the timeout arm aborts it.
 */

const noopCallbacks = {
  onToolCallEnd: async () => undefined,
  onToolCallStart: async () => undefined,
}

const stalledProviderCall = (
  observed: { signal?: AbortSignal | undefined },
  signal: AbortSignal | undefined,
): Promise<never> => {
  observed.signal = signal
  // A provider request that accepted the connection and then stalled: it
  // settles only if somebody aborts it, exactly like an undici request
  // whose signal fires.
  return new Promise<never>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason))
  })
}

test('a timed-out tool call is aborted, not merely out-raced', async () => {
  const observed: { signal?: AbortSignal | undefined } = {}
  const batch = await executeToolBatch({
    callbacks: noopCallbacks,
    circuitBreaker: new ToolCircuitBreaker(),
    executeTool: (_toolName, _args, _toolCallId, signal) =>
      stalledProviderCall(observed, signal),
    signatureCounts: new Map(),
    toolCalls: [{ arguments: {}, toolCallId: 'tc-1', toolName: 'gmail_send' }],
    toolTimeoutMs: 25,
  })

  // The stalled call learned of the timeout...
  assert.ok(observed.signal, 'the executor must receive a signal')
  assert.equal(observed.signal.aborted, true)
  // ...and the loop still records the timeout verdict, not the abort: the
  // rejection order inside the timeout arm is what keeps the output honest.
  assert.equal(batch.results.length, 1)
  assert.equal(batch.results[0]?.success, false)
  assert.match(batch.results[0]?.output ?? '', /timed out/)
})

test('a prepared execution is aborted through the same signal', async () => {
  const observed: { signal?: AbortSignal | undefined } = {}
  const batch = await executeToolBatch({
    callbacks: noopCallbacks,
    circuitBreaker: new ToolCircuitBreaker(),
    executeTool: async () => {
      throw new Error('prepareTool handles every call in this test')
    },
    prepareTool: async () => ({
      execute: (signal) => stalledProviderCall(observed, signal),
      kind: 'execute',
    }),
    signatureCounts: new Map(),
    toolCalls: [{ arguments: {}, toolCallId: 'tc-1', toolName: 'calendar_update' }],
    toolTimeoutMs: 25,
  })

  assert.ok(observed.signal, 'the prepared execution must receive a signal')
  assert.equal(observed.signal.aborted, true)
  assert.equal(batch.results[0]?.success, false)
  assert.match(batch.results[0]?.output ?? '', /timed out/)
})

test('a call that finishes inside its timeout is never aborted', async () => {
  const observed: { signal?: AbortSignal | undefined } = {}
  const batch = await executeToolBatch({
    callbacks: noopCallbacks,
    circuitBreaker: new ToolCircuitBreaker(),
    executeTool: async (_toolName, _args, _toolCallId, signal) => {
      observed.signal = signal
      return { inputSummary: '', output: 'done', success: true }
    },
    signatureCounts: new Map(),
    toolCalls: [{ arguments: {}, toolCallId: 'tc-1', toolName: 'gmail_search' }],
    toolTimeoutMs: 5_000,
  })

  assert.equal(batch.results[0]?.success, true)
  assert.equal(batch.results[0]?.output, 'done')
  assert.ok(observed.signal)
  assert.equal(observed.signal.aborted, false)
})
