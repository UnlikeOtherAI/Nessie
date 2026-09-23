import assert from 'node:assert/strict'
import test from 'node:test'

import { ToolCircuitBreaker } from './circuit-breaker.js'
import { ExecutorUnknownOutcomeError } from './executor-command-timing.js'
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
    toolTimeoutMsFor: () => 25,
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
    toolTimeoutMsFor: () => 25,
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
    toolTimeoutMsFor: () => 5_000,
  })

  assert.equal(batch.results[0]?.success, true)
  assert.equal(batch.results[0]?.output, 'done')
  assert.ok(observed.signal)
  assert.equal(observed.signal.aborted, false)
})

test('a backstop that gives up on an executor dispatch ends the row it opened, not a new one', async () => {
  // The executor toolset knows the ToolCall a call's command was recorded
  // under before the command exists, and the timeout error names it: without
  // that, the batch ended the call by creating a second row and the first
  // read as a tool still running.
  const ended: Array<string | undefined> = []
  const unknown = new ExecutorUnknownOutcomeError('record-for-tc-1')
  await assert.rejects(executeToolBatch({
    callbacks: {
      onToolCallEnd: async (...args) => { ended.push(args[8]) },
      onToolCallStart: async () => undefined,
    },
    circuitBreaker: new ToolCircuitBreaker(),
    executeTool: (_toolName, _args, _toolCallId, signal) => stalledProviderCall({}, signal),
    signatureCounts: new Map(),
    toolCalls: [{ arguments: {}, toolCallId: 'tc-1', toolName: 'executor_mcp_call' }],
    toolTimeoutError: (_toolName, toolCallId) => (toolCallId === 'tc-1' ? unknown : null),
    toolTimeoutMsFor: () => 25,
  }), (error) => error === unknown)
  assert.deepEqual(ended, ['record-for-tc-1'])
})
