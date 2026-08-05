import assert from 'node:assert/strict'
import test from 'node:test'

import {
  shouldWindDown,
  stopAfterInference,
  stopAfterToolBatch,
  stopBeforeIteration,
  type BudgetLimits,
} from './loop-budget.js'

const budget = (over: Partial<BudgetLimits> = {}): BudgetLimits => ({
  maxCostCents: 1_000,
  maxIterations: 100,
  maxTokens: 100_000,
  maxToolCalls: 100,
  maxWallclockMs: 100_000,
  ...over,
})

test('token and cost stops fire at 90%, leaving headroom for the checkpoint', () => {
  assert.equal(stopAfterInference(budget(), { totalCostCents: 0, totalTokensUsed: 89_999 }), null)
  assert.equal(stopAfterInference(budget(), { totalCostCents: 0, totalTokensUsed: 90_000 }), 'tokens')
  assert.equal(stopAfterInference(budget(), { totalCostCents: 899, totalTokensUsed: 0 }), null)
  assert.equal(stopAfterInference(budget(), { totalCostCents: 900, totalTokensUsed: 0 }), 'cost')
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
    stopAfterInference(noSpendCaps, { totalCostCents: 10_000, totalTokensUsed: 10_000_000 }),
    null,
  )
})

const usage = (over: Partial<Parameters<typeof shouldWindDown>[1]> = {}) => ({
  elapsedMs: 0,
  iterations: 0,
  toolCallsUsed: 0,
  totalCostCents: 0,
  totalTokensUsed: 0,
  ...over,
})

test('wind-down fires at 80% of a fractional dimension, before the 90% stop', () => {
  const caps = budget({ maxTokens: 100_000 })
  assert.equal(shouldWindDown(caps, usage({ totalTokensUsed: 79_000 })), false)
  assert.equal(shouldWindDown(caps, usage({ totalTokensUsed: 80_000 })), true)
  // The stop boundary has not tripped yet at the wind-down point.
  assert.equal(stopAfterInference(caps, usage({ totalTokensUsed: 80_000 })), null)
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
    shouldWindDown(noSpendCaps, usage({ totalCostCents: 10_000, totalTokensUsed: 10_000_000 })),
    false,
  )
})
