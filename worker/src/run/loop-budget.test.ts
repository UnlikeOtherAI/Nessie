import assert from 'node:assert/strict'
import test from 'node:test'

import {
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
