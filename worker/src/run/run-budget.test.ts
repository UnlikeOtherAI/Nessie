import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { DEFAULT_CACHE_READ_WEIGHT } from './loop-budget.js'
import {
  createDelegateGate,
  DELEGATE_BUDGET,
  parseAgentRunLimits,
  resolveAutoContinuations,
  resolveCacheReadWeight,
  resolveCacheReadWeightFromEnv,
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

test('a wound-down gate refuses new sub-agents with the wind-down message', () => {
  const gate = createDelegateGate(5)
  assert.equal(gate.tryAcquire(), true)
  gate.closeForWindDown()
  assert.equal(gate.tryAcquire(), false)
  assert.match(gate.overLimitMessage(), /winding down/)
})

test('delegate and continuation counts read their env with sane defaults', () => {
  assert.equal(resolveMaxDelegatesPerRun({}), 16)
  assert.equal(resolveMaxDelegatesPerRun({ NESSIE_MAX_DELEGATES_PER_RUN: '3' }), 3)
  assert.equal(resolveMaxDelegatesPerRun({ NESSIE_MAX_DELEGATES_PER_RUN: '0' }), 0)
  assert.equal(resolveAutoContinuations({}), 2)
  assert.equal(resolveAutoContinuations({ NESSIE_RUN_AUTO_CONTINUATIONS: '5' }), 5)
})

// --- Cache-read weight ---

const decimal = (value: number) => ({ toNumber: () => value })

const pricingPrisma = (row: unknown): PrismaClient =>
  ({ modelPricingProfile: { findFirst: async () => row } }) as unknown as PrismaClient

const MODEL = { model: 'deepseek-v4-flash', organizationId: 'org-1', provider: 'deepseek' }

test('the env weight is the fallback, and junk values fall back to the default', () => {
  assert.equal(resolveCacheReadWeightFromEnv({}), DEFAULT_CACHE_READ_WEIGHT)
  assert.equal(resolveCacheReadWeightFromEnv({ NESSIE_CACHE_READ_WEIGHT: '0.1' }), 0.1)
  assert.equal(resolveCacheReadWeightFromEnv({ NESSIE_CACHE_READ_WEIGHT: '0' }), 0)
  // Out of range or unparseable: a weight is a price ratio in [0, 1].
  for (const raw of ['1.5', '-0.2', 'cheap', '']) {
    assert.equal(
      resolveCacheReadWeightFromEnv({ NESSIE_CACHE_READ_WEIGHT: raw }),
      DEFAULT_CACHE_READ_WEIGHT,
    )
  }
})

test('the org pricing rows win over the env fallback', async () => {
  const weight = await resolveCacheReadWeight(
    pricingPrisma({ cacheReadPerMillion: decimal(0.028), inputPerMillion: decimal(0.28) }),
    MODEL,
    { NESSIE_CACHE_READ_WEIGHT: '0.5' },
  )
  assert.ok(Math.abs(weight - 0.1) < 1e-9)
})

test('a cache rate dearer than input clamps to 1 rather than inflating the meter', async () => {
  const weight = await resolveCacheReadWeight(
    pricingPrisma({ cacheReadPerMillion: decimal(5), inputPerMillion: decimal(1) }),
    MODEL,
    {},
  )
  assert.equal(weight, 1)
})

test('incomplete, missing or unreadable pricing degrades to the env default', async () => {
  const env = { NESSIE_CACHE_READ_WEIGHT: '0.3' }
  const cases: PrismaClient[] = [
    pricingPrisma(null),
    pricingPrisma({ cacheReadPerMillion: null, inputPerMillion: decimal(0.28) }),
    // A zero input rate cannot form a ratio.
    pricingPrisma({ cacheReadPerMillion: decimal(0.028), inputPerMillion: decimal(0) }),
    ({
      modelPricingProfile: {
        findFirst: async () => {
          throw new Error('db is down')
        },
      },
    }) as unknown as PrismaClient,
  ]
  for (const prisma of cases) {
    assert.equal(await resolveCacheReadWeight(prisma, MODEL, env), 0.3)
  }
})

test('an agent without a resolved provider/model never queries pricing', async () => {
  const prisma = {
    modelPricingProfile: {
      findFirst: async () => {
        throw new Error('should not be queried')
      },
    },
  } as unknown as PrismaClient
  const env = { NESSIE_CACHE_READ_WEIGHT: '0.2' }
  assert.equal(await resolveCacheReadWeight(prisma, { ...MODEL, model: null }, env), 0.2)
  assert.equal(await resolveCacheReadWeight(prisma, { ...MODEL, provider: null }, env), 0.2)
})
