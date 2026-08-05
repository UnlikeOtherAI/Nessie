import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDelegateGate,
  DELEGATE_BUDGET,
  parseAgentRunLimits,
  resolveAutoContinuations,
  resolveEffectiveRunBudget,
  resolveMaxDelegatesPerRun,
  RUN_BACKSTOP_DEFAULTS,
} from './run-budget.js'

test('an agent with no explicit limits runs on the deployment backstop', () => {
  const budget = resolveEffectiveRunBudget(null, {})
  assert.equal(budget.maxTokens, RUN_BACKSTOP_DEFAULTS.maxTokens)
  assert.equal(budget.maxToolCalls, RUN_BACKSTOP_DEFAULTS.maxToolCalls)
  assert.equal(budget.maxIterations, RUN_BACKSTOP_DEFAULTS.maxIterations)
  assert.equal(budget.maxWallclockMs, RUN_BACKSTOP_DEFAULTS.maxWallclockMs)
  assert.equal(budget.maxCostCents, RUN_BACKSTOP_DEFAULTS.maxCostCents)
})

test('explicit run limits win per dimension; absent keys keep the backstop', () => {
  const budget = resolveEffectiveRunBudget({ maxTokens: 12_345, maxIterations: 7 }, {})
  assert.equal(budget.maxTokens, 12_345)
  assert.equal(budget.maxIterations, 7)
  assert.equal(budget.maxToolCalls, RUN_BACKSTOP_DEFAULTS.maxToolCalls)
  assert.equal(budget.maxCostCents, RUN_BACKSTOP_DEFAULTS.maxCostCents)
})

test('backstop env overrides are applied, and junk values fall back to defaults', () => {
  const configured = resolveEffectiveRunBudget(null, {
    NESSIE_RUN_BACKSTOP_MAX_TOKENS: '900000',
    NESSIE_RUN_BACKSTOP_MAX_TOOL_CALLS: 'not-a-number',
    NESSIE_RUN_BACKSTOP_MAX_ITERATIONS: '0',
  })
  assert.equal(configured.maxTokens, 900_000)
  assert.equal(configured.maxToolCalls, RUN_BACKSTOP_DEFAULTS.maxToolCalls)
  assert.equal(configured.maxIterations, RUN_BACKSTOP_DEFAULTS.maxIterations)
})

test('effort no longer feeds the run budget: identical agents resolve identically', () => {
  assert.deepEqual(
    resolveEffectiveRunBudget(null, {}),
    resolveEffectiveRunBudget(undefined, {}),
  )
})

test('malformed Agent.runLimits is treated as "no explicit limits"', () => {
  assert.equal(parseAgentRunLimits(null), null)
  assert.equal(parseAgentRunLimits({ maxTokens: -5 }), null)
  assert.equal(parseAgentRunLimits({ nope: 1 }), null)
  assert.deepEqual(parseAgentRunLimits({ maxTokens: 10 }), { maxTokens: 10 })
})

test('delegate sub-agents run on the fixed small envelope', () => {
  assert.equal(DELEGATE_BUDGET.maxIterations, 6)
  assert.equal(DELEGATE_BUDGET.maxToolCalls, 10)
  assert.equal(DELEGATE_BUDGET.maxWallclockMs, 90_000)
  assert.equal(DELEGATE_BUDGET.maxTokens, 30_000)
  assert.equal(DELEGATE_BUDGET.maxCostCents, 100)
})

test('the per-run delegate gate opens exactly max times, then refuses clearly', () => {
  const gate = createDelegateGate(2)
  assert.equal(gate.tryAcquire(), true)
  assert.equal(gate.tryAcquire(), true)
  assert.equal(gate.tryAcquire(), false)
  assert.equal(gate.tryAcquire(), false)
  assert.match(gate.overLimitMessage(), /already used its 2 sub-agents/)
})

test('delegate and continuation counts read their env with sane defaults', () => {
  assert.equal(resolveMaxDelegatesPerRun({}), 16)
  assert.equal(resolveMaxDelegatesPerRun({ NESSIE_MAX_DELEGATES_PER_RUN: '3' }), 3)
  assert.equal(resolveMaxDelegatesPerRun({ NESSIE_MAX_DELEGATES_PER_RUN: '0' }), 0)
  assert.equal(resolveAutoContinuations({}), 2)
  assert.equal(resolveAutoContinuations({ NESSIE_RUN_AUTO_CONTINUATIONS: '5' }), 5)
})
