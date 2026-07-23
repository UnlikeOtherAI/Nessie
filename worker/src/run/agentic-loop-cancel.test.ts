import assert from 'node:assert/strict'
import test from 'node:test'

import type { InferenceResult, ProviderMessage } from '@nessie/runtime'
import { runAgenticLoop, type BudgetLimits } from './agentic-loop.js'

const HIGH = 1_000_000

const budget = (): BudgetLimits => ({
  maxIterations: HIGH,
  maxToolCalls: HIGH,
  maxWallclockMs: HIGH,
  maxTokens: HIGH,
  maxCostCents: HIGH,
  toolTimeoutMs: HIGH,
})

// Always asks for one tool call so the loop never terminates naturally, and
// carries partial assistant text so we can assert it survives a cancel.
const toolCallInference = (): InferenceResult => ({
  correlationId: undefined,
  finishReason: undefined,
  invocations: [],
  model: 'test-model',
  outputText: 'partial progress so far',
  provider: 'openai',
  requestId: 'req-1',
  toolCalls: [{ arguments: { n: 1 }, toolCallId: 'tc-1', toolName: 'noop' }],
})

// A final answer with no tool calls, so the loop finishes naturally.
const finalInference = (): InferenceResult => ({
  correlationId: undefined,
  finishReason: undefined,
  invocations: [],
  model: 'test-model',
  outputText: 'done',
  provider: 'openai',
  requestId: 'req-1',
  toolCalls: [],
})

const noopCallbacks = () => ({
  onIterationStart: async () => undefined,
  onToolCallStart: async () => undefined,
  onToolCallEnd: async () => undefined,
  onTextDelta: async () => undefined,
  onBudgetExhausted: async () => undefined,
})

const initial: ProviderMessage[] = [{ content: 'go', role: 'user' }]

test('cancel requested before the first inference stops with 0 iterations', async () => {
  let inferenceCalls = 0
  let toolCalls = 0
  const result = await runAgenticLoop({
    budget: budget(),
    callbacks: noopCallbacks(),
    // Cancelled from the outset: the top-of-loop probe trips immediately.
    checkCancelled: async () => true,
    executeTool: async () => {
      toolCalls += 1
      return { inputSummary: 'noop', output: 'ran', success: true }
    },
    initialMessages: initial,
    runInference: async () => {
      inferenceCalls += 1
      return toolCallInference()
    },
    tools: [],
  })

  assert.equal(result.cancelled, true)
  assert.equal(result.exhaustedBudget, null)
  assert.equal(result.iterations, 0)
  assert.equal(inferenceCalls, 0, 'no inference runs once cancel is observed')
  assert.equal(toolCalls, 0, 'no tools run once cancel is observed')
})

test('cancel is honored between tool-call batches and keeps partial text', async () => {
  let probe = 0
  let toolCalls = 0
  const result = await runAgenticLoop({
    budget: budget(),
    callbacks: noopCallbacks(),
    // false at the first top-of-loop check, true at the post-tool-batch check.
    checkCancelled: async () => {
      probe += 1
      return probe >= 2
    },
    executeTool: async () => {
      toolCalls += 1
      return { inputSummary: 'noop', output: 'ran', success: true }
    },
    initialMessages: initial,
    runInference: async () => toolCallInference(),
    tools: [],
  })

  assert.equal(result.cancelled, true)
  assert.equal(result.exhaustedBudget, null)
  assert.equal(result.iterations, 1, 'exactly one iteration ran before cancel')
  assert.equal(toolCalls, 1, 'the in-flight tool batch completed before stopping')
  assert.equal(result.finalText, 'partial progress so far')
})

test('cancel is honored between iterations', async () => {
  let probe = 0
  const result = await runAgenticLoop({
    budget: budget(),
    callbacks: noopCallbacks(),
    // Allow the first iteration (top + post-batch checks false), then cancel at
    // the top of the second iteration.
    checkCancelled: async () => {
      probe += 1
      return probe >= 3
    },
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: initial,
    runInference: async () => toolCallInference(),
    tools: [],
  })

  assert.equal(result.cancelled, true)
  assert.equal(result.iterations, 1, 'stopped at the top of the second iteration')
})

test('no cancel: the loop completes normally with cancelled=false', async () => {
  const result = await runAgenticLoop({
    budget: budget(),
    callbacks: noopCallbacks(),
    checkCancelled: async () => false,
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: initial,
    runInference: async () => finalInference(),
    tools: [],
  })

  assert.equal(result.cancelled, false)
  assert.equal(result.exhaustedBudget, null)
  assert.equal(result.finalText, 'done')
})
