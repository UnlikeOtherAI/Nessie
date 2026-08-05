import assert from 'node:assert/strict'
import test from 'node:test'

import type { InferenceResult, ProviderMessage } from '@nessie/runtime'
import { runAgenticLoop, type BudgetLimits } from '../src/run/agentic-loop.js'
import { resolveEffectiveRunBudget } from '../src/run/run-budget.js'

// Regression for the 2026-08-05 incident: a personal-assistant run was killed by
// the 500k-token deployment backstop at a claimed 504,738 tokens. The
// per-invocation ledger rows showed the real composition was ~142k fresh input,
// ~361k CACHE READS and ~10k output across 17 DeepSeek v4-flash calls — a
// provider where a cache read costs about a tenth of fresh input. The loop
// metered provider `usage.totalTokens` flat, so it charged full price for
// re-served context and killed a run whose true spend was ~37% of the number it
// was judged on.
//
// The profile below reproduces that shape call-for-call.

const FRESH_INPUT = [
  8_189, 154, 356, 318, 314, 567, 475, 11_259,
  333, 10_953, 426, 11_128, 7_418, 7_411, 1_198, 76_292,
]
const CACHE_READ = [
  0, 8_320, 8_960, 9_600, 10_112, 10_624, 11_392, 12_416,
  24_064, 24_576, 36_096, 36_864, 48_256, 55_936, 63_744, 0,
]
const OUTPUT = [
  212, 348, 501, 664, 733, 845, 396, 902,
  255, 611, 774, 483, 690, 828, 917, 915,
]

const RAW_TOTAL = 507_825
const CACHE_READ_TOTAL = 360_960
// 136,791 fresh + 10,074 output + 36,096 (cache reads at one tenth).
const EFFECTIVE_AT_ONE_TENTH = 182_961

const FINAL_ANSWER = 'Here is the research summary you asked for.'

const noopCallbacks = () => ({
  onIterationStart: async () => undefined,
  onToolCallStart: async () => undefined,
  onToolCallEnd: async () => undefined,
  onTextDelta: async () => undefined,
  onBudgetExhausted: async () => undefined,
})

const invocation = (call: number): InferenceResult['invocations'][number] => ({
  invocationId: `inv-${call}`,
  latencyMs: 1,
  model: 'deepseek-v4-flash',
  operationType: 'chat',
  provider: 'openai',
  requestId: `req-${call}`,
  usage: {
    cacheReadTokens: CACHE_READ[call]!,
    inputTokens: FRESH_INPUT[call]!,
    outputTokens: OUTPUT[call]!,
    // Providers report the total as input + cacheRead + output.
    totalTokens: FRESH_INPUT[call]! + CACHE_READ[call]! + OUTPUT[call]!,
  },
})

// Replays the incident: 15 tool-calling turns then a delivered answer.
const runIncidentProfile = async (cacheReadWeight: number) => {
  let call = -1
  return runAgenticLoop({
    budget: resolveEffectiveRunBudget(null, {}),
    cacheReadWeight,
    callbacks: noopCallbacks(),
    executeTool: async () => ({ inputSummary: 'search', output: 'results', success: true }),
    initialMessages: [{ content: 'Research slack clones.', role: 'user' }],
    runInference: async () => {
      call += 1
      const last = call === FRESH_INPUT.length - 1
      return {
        correlationId: undefined,
        finishReason: last ? 'stop' : 'tool-call',
        invocations: [invocation(call)],
        model: 'deepseek-v4-flash',
        outputText: last ? FINAL_ANSWER : `working, step ${call}`,
        provider: 'openai',
        requestId: `req-${call}`,
        // Distinct arguments per turn, so loop detection never fires.
        toolCalls: last
          ? []
          : [{ arguments: { step: call }, toolCallId: `tc-${call}`, toolName: 'web_search' }],
      }
    },
    tools: [],
  })
}

test('the incident profile completes once cache reads are metered at their price', async () => {
  const result = await runIncidentProfile(0.1)

  // The raw provider total is what killed the run: it is over the backstop.
  assert.equal(result.totalTokensUsed, RAW_TOTAL)
  assert.ok(result.totalTokensUsed > 500_000, 'the raw total still exceeds the backstop')
  assert.equal(result.cacheReadTokens, CACHE_READ_TOTAL)

  // What the budget now meters is ~37% of that, and well inside the cap.
  assert.equal(result.effectiveTokensUsed, EFFECTIVE_AT_ONE_TENTH)
  assert.ok(result.effectiveTokensUsed < 450_000, 'effective spend stays under the 90% stop')

  // So the run delivers instead of being cut off.
  assert.equal(result.exhaustedBudget, null)
  assert.equal(result.finalText, FINAL_ANSWER)
  assert.equal(result.iterations, FRESH_INPUT.length)
})

test('metering cache reads at full price is what killed the run', async () => {
  // Weight 1 is the old flat behaviour: identical script, identical budget.
  const result = await runIncidentProfile(1)

  assert.equal(result.exhaustedBudget, 'tokens')
  assert.equal(result.effectiveTokensUsed, RAW_TOTAL)
  // The model's answer was produced and then thrown into a cap stop.
  assert.equal(result.finalText, FINAL_ANSWER)
})

test('usage without a granular split still meters as the provider total', async () => {
  const result = await runAgenticLoop({
    budget: { maxIterations: 8, maxTokens: 1_000, maxToolCalls: 8, maxWallclockMs: 60_000 },
    cacheReadWeight: 0.1,
    callbacks: noopCallbacks(),
    executeTool: async () => ({ inputSummary: '', output: 'ran', success: true }),
    initialMessages: [{ content: 'go', role: 'user' }],
    runInference: async () => ({
      correlationId: undefined,
      finishReason: 'tool-call',
      invocations: [
        { usage: { totalTokens: 950 } } as unknown as InferenceResult['invocations'][number],
      ],
      model: 'test-model',
      outputText: 'partial',
      provider: 'openai',
      requestId: 'req-1',
      toolCalls: [{ arguments: {}, toolCallId: 'tc-1', toolName: 'noop' }],
    }),
    tools: [],
  })

  // No split to discount: the whole total counts, exactly as before.
  assert.equal(result.effectiveTokensUsed, 950)
  assert.equal(result.totalTokensUsed, 950)
  assert.equal(result.exhaustedBudget, 'tokens')
})

test('a call that would overshoot the token limit is never dispatched', async () => {
  let inferenceCalls = 0
  const oversized: ProviderMessage[] = [{ content: 'x'.repeat(40_000), role: 'user' }]

  const budget: BudgetLimits = {
    maxIterations: 8,
    maxTokens: 5_000,
    maxToolCalls: 8,
    maxWallclockMs: 60_000,
  }

  const result = await runAgenticLoop({
    budget,
    callbacks: noopCallbacks(),
    executeTool: async () => ({ inputSummary: '', output: '', success: true }),
    initialMessages: oversized,
    runInference: async () => {
      inferenceCalls += 1
      throw new Error('the pre-flight gate should have stopped this run')
    },
    tools: [],
  })

  assert.equal(inferenceCalls, 0, 'no inference call is billed past the cap')
  assert.equal(result.exhaustedBudget, 'tokens')
  assert.equal(result.totalTokensUsed, 0)
  assert.equal(result.effectiveTokensUsed, 0)
})
