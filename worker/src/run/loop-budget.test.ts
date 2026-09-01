import assert from 'node:assert/strict'
import test from 'node:test'

import type { InvocationRecord } from '@nessie/runtime'
import {
  DEFAULT_CACHE_READ_WEIGHT,
  meterSpend,
  shouldWindDown,
  stopAfterInference,
  stopAfterToolBatch,
  stopBeforeInference,
  stopBeforeIteration,
  type BudgetLimits,
} from './loop-budget.js'

const invocation = (usage: InvocationRecord['usage']): InvocationRecord =>
  ({ usage } as InvocationRecord)

const budget = (over: Partial<BudgetLimits> = {}): BudgetLimits => ({
  maxCostCents: 1_000,
  maxIterations: 100,
  maxTokens: 100_000,
  maxToolCalls: 100,
  maxWallclockMs: 100_000,
  ...over,
})

test('token and cost stops fire at 90%, leaving headroom for the checkpoint', () => {
  assert.equal(stopAfterInference(budget(), { totalCostCents: 0, effectiveTokensUsed: 89_999 }), null)
  assert.equal(stopAfterInference(budget(), { totalCostCents: 0, effectiveTokensUsed: 90_000 }), 'tokens')
  assert.equal(stopAfterInference(budget(), { totalCostCents: 899, effectiveTokensUsed: 0 }), null)
  assert.equal(stopAfterInference(budget(), { totalCostCents: 900, effectiveTokensUsed: 0 }), 'cost')
})

test('wall-clock stops at 90% of the limit', () => {
  assert.equal(stopBeforeIteration(budget(), { elapsedMs: 89_999, iterations: 0 }), null)
  assert.equal(stopBeforeIteration(budget(), { elapsedMs: 90_000, iterations: 0 }), 'wallclock')
  assert.equal(
    stopAfterToolBatch(budget(), { elapsedMs: 90_000, toolCallsUsed: 0 }),
    'wallclock',
  )
})

test('countable dimensions reserve one whole unit rather than a fraction', () => {
  assert.equal(stopBeforeIteration(budget({ maxIterations: 10 }), { elapsedMs: 0, iterations: 8 }), null)
  assert.equal(
    stopBeforeIteration(budget({ maxIterations: 10 }), { elapsedMs: 0, iterations: 9 }),
    'iterations',
  )
  assert.equal(stopAfterToolBatch(budget({ maxToolCalls: 4 }), { elapsedMs: 0, toolCallsUsed: 2 }), null)
  assert.equal(
    stopAfterToolBatch(budget({ maxToolCalls: 4 }), { elapsedMs: 0, toolCallsUsed: 3 }),
    'tool_calls',
  )
})

test('a limit of one still permits exactly one unit of work', () => {
  assert.equal(stopBeforeIteration(budget({ maxIterations: 1 }), { elapsedMs: 0, iterations: 0 }), null)
  assert.equal(
    stopBeforeIteration(budget({ maxIterations: 1 }), { elapsedMs: 0, iterations: 1 }),
    'iterations',
  )
})

test('absent token/cost limits never stop the loop', () => {
  const noSpendCaps = budget({ maxCostCents: undefined, maxTokens: undefined })
  assert.equal(
    stopAfterInference(noSpendCaps, { totalCostCents: 10_000, effectiveTokensUsed: 10_000_000 }),
    null,
  )
})

const usage = (over: Partial<Parameters<typeof shouldWindDown>[1]> = {}) => ({
  elapsedMs: 0,
  iterations: 0,
  toolCallsUsed: 0,
  totalCostCents: 0,
  effectiveTokensUsed: 0,
  ...over,
})

test('wind-down fires at 80% of a fractional dimension, before the 90% stop', () => {
  const caps = budget({ maxTokens: 100_000 })
  assert.equal(shouldWindDown(caps, usage({ effectiveTokensUsed: 79_000 })), false)
  assert.equal(shouldWindDown(caps, usage({ effectiveTokensUsed: 80_000 })), true)
  // The stop boundary has not tripped yet at the wind-down point.
  assert.equal(stopAfterInference(caps, usage({ effectiveTokensUsed: 80_000 })), null)
})

test('countable dimensions wind down one working turn before the stop reserve', () => {
  const caps = budget({ maxIterations: 10 })
  assert.equal(shouldWindDown(caps, usage({ iterations: 7 })), false)
  assert.equal(shouldWindDown(caps, usage({ iterations: 8 })), true)
  assert.equal(stopBeforeIteration(caps, usage({ iterations: 8 })), null)
  assert.equal(stopBeforeIteration(caps, usage({ iterations: 9 })), 'iterations')
})

test('absent spend caps never trigger wind-down on tokens or cost', () => {
  const noSpendCaps = budget({ maxCostCents: undefined, maxTokens: undefined })
  assert.equal(
    shouldWindDown(noSpendCaps, usage({ totalCostCents: 10_000, effectiveTokensUsed: 10_000_000 })),
    false,
  )
})

test('cache reads are metered at the run weight, not at full input price', () => {
  const invocations = [
    invocation({ cacheReadTokens: 0, inputTokens: 8_189, outputTokens: 200, totalTokens: 8_389 }),
    invocation({
      cacheReadTokens: 8_320,
      inputTokens: 154,
      outputTokens: 300,
      totalTokens: 8_774,
    }),
  ]

  const tenth = meterSpend(invocations, 0.1)
  assert.equal(tenth.totalTokensUsed, 17_163)
  assert.equal(tenth.cacheReadTokens, 8_320)
  // 8189 + 154 + 200 + 300 + round(0.1 * 8320)
  assert.equal(tenth.effectiveTokensUsed, 9_675)

  // A weight of 1 is the old flat behaviour: effective == raw.
  assert.equal(meterSpend(invocations, 1).effectiveTokensUsed, 17_163)
})

test('usage without a granular split degrades to the provider total', () => {
  const spend = meterSpend([invocation({ totalTokens: 4_242 })], 0.1)
  assert.equal(spend.effectiveTokensUsed, 4_242)
  assert.equal(spend.totalTokensUsed, 4_242)
  assert.equal(spend.cacheReadTokens, 0)
})

test('only USD provider-reported cost is summed into the cost dimension', () => {
  const usd = { providerReportedCost: { amount: 0.5, currency: 'usd' }, usage: {} }
  const eur = { providerReportedCost: { amount: 9, currency: 'EUR' }, usage: {} }
  const spend = meterSpend(
    [usd, eur] as unknown as InvocationRecord[],
    DEFAULT_CACHE_READ_WEIGHT,
  )
  assert.equal(spend.totalCostCents, 50)
})

test('the pre-flight gate refuses a call that would overshoot the full limit', () => {
  const caps = budget({ maxTokens: 100_000 })
  // Post-hoc headroom (90%) is untouched: this is the 100% boundary.
  assert.equal(
    stopBeforeInference(caps, { effectiveTokensUsed: 40_000, projectedCallTokens: 60_000 }),
    null,
  )
  assert.equal(
    stopBeforeInference(caps, { effectiveTokensUsed: 40_000, projectedCallTokens: 60_001 }),
    'tokens',
  )
})

test('the pre-flight gate is inert without a token limit', () => {
  assert.equal(
    stopBeforeInference(budget({ maxTokens: undefined }), {
      effectiveTokensUsed: 10_000_000,
      projectedCallTokens: 10_000_000,
    }),
    null,
  )
})
