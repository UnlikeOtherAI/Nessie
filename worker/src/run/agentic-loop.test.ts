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

// The reserved headroom is what pays for the checkpoint note: the loop must
// stop with budget still on the table, not after burning all of it.
test('the stop leaves headroom for the checkpoint call', async () => {
  const result = await runCapped({ maxIterations: 10 })
  assert.equal(result.exhaustedBudget, 'iterations')
  assert.equal(result.iterations, 9)
  // The transcript is returned so the caller can write the checkpoint note.
  assert.ok(result.messages.length > 1)
})

test('a mid-run org-budget block stops the loop with its own classification', async () => {
  let iterations = 0
  const result = await runAgenticLoop({
    budget: budget({}),
    callbacks: noopCallbacks(),
    checkBudgetBlocked: async () => iterations >= 2,
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: initial,
    runInference: async () => {
      iterations += 1
      return toolCallInference('partial progress so far')
    },
    tools: [],
  })
  assert.equal(result.exhaustedBudget, 'org_budget_blocked')
  assert.equal(classifyBudgetStop(result.exhaustedBudget!), 'org_budget_blocked')
  assert.equal(result.finalText, 'partial progress so far')
})

test('compaction runs between iterations and its spend joins the run totals', async () => {
  const sink: InferenceResult['invocations'] = []
  const compactionCalls: number[] = []
  const bulky = 'y'.repeat(60_000)

  await runAgenticLoop({
    budget: budget({ maxIterations: 4 }),
    callbacks: noopCallbacks(),
    compactContext: async ({ messages, targetTokens }) => {
      compactionCalls.push(targetTokens)
      // Whatever the real compaction does, it must never hand back an orphan
      // tool result; the caller replaces the transcript with what we return.
      const system = messages.filter((message) => message.role === 'system')
      sink.push({ usage: { totalTokens: 25 } } as unknown as InferenceResult['invocations'][number])
      return [...system, { content: 'compacted work notes', role: 'system' }]
    },
    contextPlan: { availableTokens: 1_000, targetTokens: 600, triggerTokens: 800 },
    executeTool: async () => ({ inputSummary: 'big', output: bulky, success: true }),
    initialMessages: initial,
    invocationSink: sink,
    runInference: async () => toolCallInference('working'),
    tools: [],
  })

  assert.ok(compactionCalls.length > 0, 'expected at least one compaction attempt')
  assert.deepEqual(compactionCalls, compactionCalls.map(() => 600))
  // Compaction is inference the run paid for.
  assert.ok(sink.some((invocation) => invocation.usage.totalTokens === 25))
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
    // Two iterations of real work plus the reserved graceful-stop headroom.
    budget: budget({ maxIterations: 3 }),
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
  // Middle-out: the head and the tail of the result both survive the cut.
  assert.match(content, /\n\n\[\.\.\. truncated \d+ chars \.\.\.\]\n\n/)
  assert.ok(content.startsWith('Z'.repeat(1_000)))
  assert.ok(content.endsWith('Z'.repeat(1_000)))
})

// --- Wind-down (spec §3a) ---

const finalAnswerInference = (outputText: string): InferenceResult => ({
  correlationId: undefined,
  finishReason: 'stop',
  invocations: [],
  model: 'test-model',
  outputText,
  provider: 'openai',
  requestId: 'req-1',
  toolCalls: [],
})

test('wind-down injects the instruction once and the model hands over naturally', async () => {
  let windDownFired = 0
  let sawInstruction = false
  const result = await runAgenticLoop({
    budget: budget({ maxIterations: 10 }),
    callbacks: noopCallbacks(),
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: initial,
    onWindDown: () => {
      windDownFired += 1
    },
    runInference: async (messages) => {
      sawInstruction = messages.some(
        (m) => m.role === 'system' && typeof m.content === 'string'
          && m.content.includes('WRAP UP NOW'),
      )
      return sawInstruction
        ? finalAnswerInference('here is what I have; X remains')
        : toolCallInference('working...')
    },
    tools: [],
    windDownInstruction: 'WRAP UP NOW',
  })
  assert.equal(result.woundDown, true)
  assert.equal(result.exhaustedBudget, null)
  assert.equal(result.finalText, 'here is what I have; X remains')
  assert.equal(windDownFired, 1)
  const injected = result.messages.filter(
    (m) => m.role === 'system' && typeof m.content === 'string'
      && m.content.includes('WRAP UP NOW'),
  )
  assert.equal(injected.length, 1)
})

test('without a wind-down instruction nothing is injected', async () => {
  const result = await runCapped({ maxIterations: 6 })
  assert.equal(result.woundDown, false)
  assert.equal(
    result.messages.some(
      (m) => m.role === 'system' && typeof m.content === 'string'
        && m.content.includes('WRAP UP')),
    false,
  )
})

test('a model that ignores wind-down still hits the hard stop with a checkpointable transcript', async () => {
  const result = await runAgenticLoop({
    budget: budget({ maxIterations: 10 }),
    callbacks: noopCallbacks(),
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: initial,
    runInference: async () => toolCallInference('still going'),
    tools: [],
    windDownInstruction: 'WRAP UP NOW',
  })
  assert.equal(result.woundDown, true)
  assert.equal(result.exhaustedBudget, 'iterations')
  assert.equal(result.finalText, 'still going')
  assert.ok(result.messages.length > 1)
})
