import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'

import { checkBudget, evaluateBudget, type BudgetMode } from '../src/budget.js'

// A Prisma Decimal is a `{ toNumber(): number }` at runtime; the budget module
// normalizes it. Mirror that so cost comparisons are exercised correctly.
const dec = (value: number): { toNumber(): number } => ({ toNumber: () => value })

type MockBudget = {
  organizationId: string
  scopeType: 'organization' | 'project' | 'team'
  scopeId: string
  costLimitUsd: number | null
  tokenLimit: number | null
  mode: BudgetMode
  period: 'weekly' | 'monthly' | 'yearly'
  warnThresholdPercent: number
  blockHumansWhenOver: boolean
  degradeModel: string | null
  degradeProvider: string | null
}

const budget = (over: Partial<MockBudget> = {}): MockBudget => ({
  organizationId: 'org-1',
  scopeType: 'organization',
  scopeId: 'org-1',
  costLimitUsd: 100,
  tokenLimit: null,
  mode: 'enforce',
  period: 'monthly',
  warnThresholdPercent: 80,
  blockHumansWhenOver: false,
  degradeModel: null,
  degradeProvider: null,
  ...over,
})

// Minimal in-memory Prisma surface covering exactly what evaluateBudget touches:
// budget.findMany (resolveBudget) + tokenLedgerEvent.aggregate (period usage).
const makePrisma = (budgets: MockBudget[], usage: { spentUsd: number; spentTokens: number }) => {
  const prisma = {
    budget: {
      findMany: async () =>
        budgets.map((b) => ({
          ...b,
          storageLimitBytes: null,
          costLimitUsd: b.costLimitUsd === null ? null : dec(b.costLimitUsd),
        })),
    },
    tokenLedgerEvent: {
      aggregate: async () => ({
        _sum: {
          estimatedCostAmount: dec(usage.spentUsd),
          totalTokens: usage.spentTokens,
        },
      }),
    },
  }
  return prisma as unknown as PrismaClient
}

const scope = { organizationId: 'org-1', projectId: null, teamId: null }

test('warn budget below threshold: allow verdict, level ok', async () => {
  const prisma = makePrisma([budget({ mode: 'warn' })], { spentUsd: 50, spentTokens: 0 })
  const evaluation = await evaluateBudget(prisma, scope, { isHuman: false })
  assert.equal(evaluation.decision.action, 'allow')
  assert.ok(evaluation.alert)
  assert.equal(evaluation.alert.level, 'ok')
  assert.equal(evaluation.alert.percentUsed, 50)
})

test('warn budget past threshold: allow verdict, level warn (no alert below)', async () => {
  const prisma = makePrisma([budget({ mode: 'warn' })], { spentUsd: 85, spentTokens: 0 })
  const evaluation = await evaluateBudget(prisma, scope, { isHuman: false })
  assert.equal(evaluation.decision.action, 'allow')
  assert.equal(evaluation.alert?.level, 'warn')
  assert.equal(evaluation.alert?.percentUsed, 85)
})

test('enforce budget over cap: block verdict, level over', async () => {
  const prisma = makePrisma([budget()], { spentUsd: 120, spentTokens: 0 })
  const evaluation = await evaluateBudget(prisma, scope, { isHuman: false })
  assert.equal(evaluation.decision.action, 'block')
  assert.equal(evaluation.alert?.level, 'over')
})

test('unlimited budget produces no alert snapshot', async () => {
  const prisma = makePrisma([budget({ mode: 'unlimited' })], { spentUsd: 999, spentTokens: 0 })
  const evaluation = await evaluateBudget(prisma, scope, { isHuman: false })
  assert.equal(evaluation.decision.action, 'allow')
  assert.equal(evaluation.alert, null)
})

test('no governing budget: allow, no alert', async () => {
  const prisma = makePrisma([budget({ mode: 'off' })], { spentUsd: 500, spentTokens: 0 })
  const evaluation = await evaluateBudget(prisma, scope, { isHuman: false })
  assert.equal(evaluation.decision.action, 'allow')
  assert.equal(evaluation.alert, null)
})

// The alert layer must never change the verdict: checkBudget (verdict-only) must
// equal evaluateBudget().decision for every scenario, human and automation.
test('checkBudget verdict is identical to evaluateBudget.decision', async () => {
  const scenarios: Array<{ b: MockBudget; usage: { spentUsd: number; spentTokens: number }; isHuman: boolean }> = [
    { b: budget(), usage: { spentUsd: 50, spentTokens: 0 }, isHuman: false },
    { b: budget(), usage: { spentUsd: 120, spentTokens: 0 }, isHuman: false },
    { b: budget(), usage: { spentUsd: 120, spentTokens: 0 }, isHuman: true },
    { b: budget({ blockHumansWhenOver: true }), usage: { spentUsd: 120, spentTokens: 0 }, isHuman: true },
    { b: budget({ mode: 'degrade', degradeModel: 'gpt-4o-mini', degradeProvider: 'openai' }), usage: { spentUsd: 120, spentTokens: 0 }, isHuman: false },
    { b: budget({ mode: 'degrade' }), usage: { spentUsd: 120, spentTokens: 0 }, isHuman: false },
    { b: budget({ mode: 'warn' }), usage: { spentUsd: 120, spentTokens: 0 }, isHuman: false },
    { b: budget({ mode: 'unlimited' }), usage: { spentUsd: 120, spentTokens: 0 }, isHuman: false },
  ]
  for (const { b, usage, isHuman } of scenarios) {
    const prisma = makePrisma([b], usage)
    const viaCheck = await checkBudget(prisma, scope, { isHuman })
    const viaEvaluate = (await evaluateBudget(prisma, scope, { isHuman })).decision
    assert.deepEqual(viaCheck, viaEvaluate)
  }
})
