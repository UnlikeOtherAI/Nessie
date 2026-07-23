import assert from 'node:assert/strict'
import test from 'node:test'

import type { InferenceResult, ProviderMessage } from '@nessie/runtime'
import { runAgenticLoop, type BudgetLimits } from './agentic-loop.js'
import { classifyBudgetStop } from './execute/budget-stop.js'

const HIGH = 1_000_000

const budget = (over: Partial<BudgetLimits>): BudgetLimits => ({
  maxIterations: HIGH,
  maxToolCalls: HIGH,
  maxWallclockMs: HIGH,
  maxTokens: HIGH,
  maxCostCents: HIGH,
  toolTimeoutMs: HIGH,
  ...over,
})

// Always asks for one tool call so the loop never terminates naturally, and
// carries a bit of assistant text so we can assert it survives the cap stop.
const toolCallInference = (outputText: string): InferenceResult => ({
  correlationId: undefined,
  finishReason: undefined,
  invocations: [],
  model: 'test-model',
  outputText,
  provider: 'openai',
  requestId: 'req-1',
  toolCalls: [{ arguments: { n: Math.random() }, toolCallId: 'tc-1', toolName: 'noop' }],
})

const noopCallbacks = () => ({
  onIterationStart: async () => undefined,
  onToolCallStart: async () => undefined,
  onToolCallEnd: async () => undefined,
  onTextDelta: async () => undefined,
  onBudgetExhausted: async () => undefined,
})

const initial: ProviderMessage[] = [{ content: 'go', role: 'user' }]

const runCapped = (over: Partial<BudgetLimits>) =>
  runAgenticLoop({
    budget: budget(over),
    callbacks: noopCallbacks(),
    executeTool: async () => ({
      inputSummary: 'noop',
      output: 'tool ran',
      success: true,
    }),
    initialMessages: initial,
    runInference: async () => toolCallInference('partial progress so far'),
    tools: [],
  })

test('iteration cap stops with a classified reason and keeps partial text', async () => {
  const result = await runCapped({ maxIterations: 2 })
  assert.equal(result.exhaustedBudget, 'iterations')
  assert.equal(classifyBudgetStop(result.exhaustedBudget!), 'iteration_limit')
  // Partial assistant text is surfaced, not dropped.
  assert.equal(result.finalText, 'partial progress so far')
})

test('tool-call cap stops with the tool_call_limit classification', async () => {
  const result = await runCapped({ maxToolCalls: 1 })
  assert.equal(result.exhaustedBudget, 'tool_calls')
  assert.equal(classifyBudgetStop(result.exhaustedBudget!), 'tool_call_limit')
  assert.equal(result.finalText, 'partial progress so far')
})

test('token usage over the cap classifies as token_limit', async () => {
  const result = await runAgenticLoop({
    budget: budget({ maxTokens: 100 }),
    callbacks: noopCallbacks(),
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: initial,
    runInference: async () => ({
      correlationId: undefined,
      finishReason: undefined,
      invocations: [
        { usage: { totalTokens: 500 } } as unknown as InferenceResult['invocations'][number],
      ],
      model: 'test-model',
      outputText: 'partial',
      provider: 'openai',
      requestId: 'req-1',
      toolCalls: [{ arguments: {}, toolCallId: 'tc-1', toolName: 'noop' }],
    }),
    tools: [],
  })
  assert.equal(result.exhaustedBudget, 'tokens')
  assert.equal(classifyBudgetStop(result.exhaustedBudget!), 'token_limit')
})

test('invocationSink captures partial spend even when the loop throws', async () => {
  // First inference succeeds (records an invocation + asks for a tool call);
  // the second throws a fatal, non-retryable error. The caller's sink must still
  // hold the first invocation so the failed run's token spend stays attributable.
  const sink: InferenceResult['invocations'] = []
  const inv = (id: string): InferenceResult['invocations'][number] =>
    ({ invocationId: id, usage: { totalTokens: 10 } }) as unknown as InferenceResult['invocations'][number]

  let call = 0
  await assert.rejects(
    runAgenticLoop({
      budget: budget({}),
      callbacks: noopCallbacks(),
      executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
      initialMessages: initial,
      invocationSink: sink,
      runInference: async () => {
        call += 1
        if (call === 1) {
          return {
            correlationId: undefined,
            finishReason: undefined,
            invocations: [inv('inv-1')],
            model: 'test-model',
            outputText: 'working',
            provider: 'openai',
            requestId: 'req-1',
            toolCalls: [{ arguments: {}, toolCallId: 'tc-1', toolName: 'noop' }],
          }
        }
        throw new Error('provider exploded')
      },
      tools: [],
    }),
    /provider exploded/,
  )

  assert.equal(sink.length, 1)
  assert.equal(sink[0]?.invocationId, 'inv-1')
})

test('natural completion carries no budget stop', async () => {
  const result = await runAgenticLoop({
    budget: budget({}),
    callbacks: noopCallbacks(),
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: initial,
    runInference: async () => ({
      correlationId: undefined,
      finishReason: undefined,
      invocations: [],
      model: 'test-model',
      outputText: 'final answer',
      provider: 'openai',
      requestId: 'req-1',
      toolCalls: [],
    }),
    tools: [],
  })
  assert.equal(result.exhaustedBudget, null)
  assert.equal(result.finalText, 'final answer')
})

test('oversized tool results are truncated before entering the loop context', async () => {
  let capturedMessages: ProviderMessage[] = []
  let turn = 0
  await runAgenticLoop({
    budget: budget({ maxIterations: 2 }),
    callbacks: noopCallbacks(),
    executeTool: async () => ({
      inputSummary: 'big',
      // ~200k chars of MCP-style output with no per-tool cap of its own.
      output: 'Z'.repeat(200_000),
      success: true,
    }),
    initialMessages: initial,
    runInference: async (messages) => {
      turn += 1
      if (turn === 2) capturedMessages = messages
      return toolCallInference('working')
    },
    tools: [],
  })

  const toolMessage = capturedMessages.find((m) => m.role === 'tool')
  assert.ok(toolMessage, 'expected a tool result message in context')
  const content = (toolMessage as { content: string }).content
  assert.ok(content.length < 200_000, 'tool result should have been truncated')
  assert.match(content, /\n\n\[truncated \d+ chars\]$/)
})
