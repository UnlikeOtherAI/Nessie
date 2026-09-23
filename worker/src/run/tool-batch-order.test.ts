import assert from 'node:assert/strict'
import test from 'node:test'

import { ToolCircuitBreaker } from './circuit-breaker.js'
import { ExecutorUnknownOutcomeError } from './executor-command-timing.js'
import { executeToolBatch, STOPPED_BEFORE_DISPATCH_OUTPUT, type ExecutedToolResult } from './tool-batch.js'
import { FatalToolExecutionError } from './tool-execution-errors.js'

/**
 * Executor commands share their machine's one command lane, and each one's
 * expiry starts when the worker creates it. A batch that dispatched three at
 * once therefore spent its own TTLs queueing behind itself; the batch now runs
 * them one after another in call order, and everything else beside them.
 */

const noopCallbacks = {
  onToolCallEnd: async () => undefined,
  onToolCallStart: async () => undefined,
}

const isExecutorTool = (toolName: string): boolean => toolName.startsWith('executor_')

const deferred = () => {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

const ok = (output: string): ExecutedToolResult => ({ inputSummary: output, output, success: true })

test('executor calls run one after another in call order while other tools run beside them', async () => {
  const events: string[] = []
  const releases = new Map<string, ReturnType<typeof deferred>>()
  for (const id of ['exec-1', 'exec-2', 'exec-3', 'search']) releases.set(id, deferred())

  const batch = executeToolBatch({
    callbacks: noopCallbacks,
    circuitBreaker: new ToolCircuitBreaker(),
    dispatchesInOrder: isExecutorTool,
    executeTool: async (toolName, _args, toolCallId) => {
      events.push(`start ${toolCallId}`)
      await releases.get(toolCallId)!.promise
      events.push(`end ${toolCallId}`)
      return ok(`${toolName} ${toolCallId}`)
    },
    signatureCounts: new Map(),
    toolCalls: [
      { arguments: { n: 1 }, toolCallId: 'exec-1', toolName: 'executor_mcp_call' },
      { arguments: { q: 'x' }, toolCallId: 'search', toolName: 'kb_search' },
      { arguments: { n: 2 }, toolCallId: 'exec-2', toolName: 'executor_mcp_call' },
      { arguments: { n: 3 }, toolCallId: 'exec-3', toolName: 'executor_mcp_tools' },
    ],
    toolTimeoutMsFor: () => 5_000,
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(
    [...events].sort(),
    ['start exec-1', 'start search'],
    'the first executor call and the search start together, and nothing else has',
  )

  releases.get('exec-2')!.resolve()
  releases.get('exec-1')!.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  // exec-2 was released first, but it could only start after exec-1 ended.
  assert.deepEqual(events.slice(2), ['end exec-1', 'start exec-2', 'end exec-2', 'start exec-3'])

  releases.get('exec-3')!.resolve()
  releases.get('search')!.resolve()
  const result = await batch
  assert.deepEqual(
    result.results.map((entry) => entry.toolCallId),
    ['exec-1', 'search', 'exec-2', 'exec-3'],
    'results keep the order the model asked for',
  )
})

test('a fatal executor call stops the calls queued behind it from dispatching', async () => {
  const dispatched: string[] = []
  const fatal = new FatalToolExecutionError('unknown outcome')
  await assert.rejects(
    executeToolBatch({
      callbacks: noopCallbacks,
      circuitBreaker: new ToolCircuitBreaker(),
      dispatchesInOrder: isExecutorTool,
      executeTool: async (_toolName, _args, toolCallId) => {
        dispatched.push(toolCallId)
        if (toolCallId === 'exec-1') throw fatal
        return ok(toolCallId)
      },
      signatureCounts: new Map(),
      toolCalls: [
        { arguments: { n: 1 }, toolCallId: 'exec-1', toolName: 'executor_mcp_call' },
        { arguments: { n: 2 }, toolCallId: 'exec-2', toolName: 'executor_mcp_call' },
        { arguments: {}, toolCallId: 'search', toolName: 'kb_search' },
      ],
    }),
    fatal,
  )
  // The run is requeued; nothing claimed exec-2, so its replay dispatches it.
  assert.deepEqual(dispatched.sort(), ['exec-1', 'search'])
})

test('each tool gets its own timeout from the resolver', async () => {
  const timeouts: Record<string, number> = { executor_mcp_call: 200, kb_search: 20 }
  const batch = await executeToolBatch({
    callbacks: noopCallbacks,
    circuitBreaker: new ToolCircuitBreaker(),
    executeTool: async (toolName) => {
      // Both take 60 ms: longer than the search's timeout, inside the executor's.
      await new Promise((resolve) => setTimeout(resolve, 60))
      return ok(toolName)
    },
    signatureCounts: new Map(),
    toolCalls: [
      { arguments: {}, toolCallId: 'exec', toolName: 'executor_mcp_call' },
      { arguments: {}, toolCallId: 'search', toolName: 'kb_search' },
    ],
    toolTimeoutMsFor: (toolName) => timeouts[toolName],
  })
  assert.equal(batch.results[0]?.success, true)
  assert.equal(batch.results[1]?.success, false)
  assert.match(batch.results[1]?.output ?? '', /timed out after 20ms/)
})

test('an executor tool timeout is the fatal unknown outcome, never a retriable timeout', async () => {
  const ended: Array<{ output: string; success: boolean }> = []
  await assert.rejects(
    executeToolBatch({
      callbacks: {
        onToolCallEnd: async (_name, _args, output, _duration, success) => {
          ended.push({ output, success })
        },
        onToolCallStart: async () => undefined,
      },
      circuitBreaker: new ToolCircuitBreaker(),
      dispatchesInOrder: isExecutorTool,
      // A dispatch that never settles: the command's result never arrives.
      executeTool: async () => new Promise<never>(() => undefined),
      signatureCounts: new Map(),
      toolCalls: [{ arguments: { server: 'kelpie', tool: 'navigate' }, toolCallId: 'exec', toolName: 'executor_mcp_call' }],
      toolTimeoutError: (toolName) => (isExecutorTool(toolName) ? new ExecutorUnknownOutcomeError() : null),
      toolTimeoutMsFor: () => 20,
    }),
    ExecutorUnknownOutcomeError,
  )
  assert.deepEqual(ended, [{ output: 'Tool execution could not be confirmed; retrying safely.', success: false }])
})

test('a Stop requested while executor calls wait turns the unsent ones into stopped answers', async () => {
  const sent: string[] = []
  let stop = false
  const batch = await executeToolBatch({
    callbacks: noopCallbacks,
    circuitBreaker: new ToolCircuitBreaker(),
    dispatchesInOrder: isExecutorTool,
    executeTool: async (toolName, _args, toolCallId) => {
      sent.push(toolCallId)
      // The person presses Stop while the first call is on the machine.
      if (toolCallId === 'exec-1') stop = true
      return ok(`${toolName} ${toolCallId}`)
    },
    signatureCounts: new Map(),
    stopRequested: async () => stop,
    toolCalls: [
      { arguments: { n: 1 }, toolCallId: 'exec-1', toolName: 'executor_mcp_call' },
      { arguments: { q: 'x' }, toolCallId: 'search', toolName: 'kb_search' },
      { arguments: { n: 2 }, toolCallId: 'exec-2', toolName: 'executor_mcp_call' },
      { arguments: { n: 3 }, toolCallId: 'exec-3', toolName: 'executor_mcp_call' },
    ],
    toolTimeoutMsFor: () => 5_000,
  })
  assert.deepEqual(sent.sort(), ['exec-1', 'search'], 'nothing is sent after the Stop')
  assert.deepEqual(batch.results.map((result) => [result.toolCallId, result.success]), [
    ['exec-1', true],
    ['search', true],
    ['exec-2', false],
    ['exec-3', false],
  ])
  assert.equal(batch.results[2]?.output, STOPPED_BEFORE_DISPATCH_OUTPUT)
})

test('a Stop probe that cannot read the flag sends the call as before', async () => {
  const sent: string[] = []
  await executeToolBatch({
    callbacks: noopCallbacks,
    circuitBreaker: new ToolCircuitBreaker(),
    dispatchesInOrder: isExecutorTool,
    executeTool: async (toolName, _args, toolCallId) => {
      sent.push(toolCallId)
      return ok(toolName)
    },
    signatureCounts: new Map(),
    stopRequested: async () => { throw new Error('database unavailable') },
    toolCalls: [{ arguments: {}, toolCallId: 'exec-1', toolName: 'executor_mcp_call' }],
    toolTimeoutMsFor: () => 5_000,
  })
  assert.deepEqual(sent, ['exec-1'])
})
