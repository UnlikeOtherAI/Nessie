import assert from 'node:assert/strict'
import test from 'node:test'

import type { BudgetAlertSnapshot, BudgetEvaluation } from '@nessie/runtime'
import { maybeEmitBudgetAlerts } from './budget-alert.js'
import type { ExecutionDependencies, RunContext } from './types.js'

const PERIOD_START = new Date('2026-07-01T00:00:00.000Z')

const snapshot = (over: Partial<BudgetAlertSnapshot> = {}): BudgetAlertSnapshot => ({
  organizationId: 'org-1',
  scopeType: 'organization',
  scopeId: 'org-1',
  mode: 'enforce',
  period: 'monthly',
  periodStart: PERIOD_START,
  spentUsd: 85,
  costLimitUsd: 100,
  spentTokens: 0,
  tokenLimit: null,
  percentUsed: 85,
  warnThresholdPercent: 80,
  level: 'warn',
  ...over,
})

type Recorded = {
  alerts: Array<{ scopeType: string; scopeId: string; periodStart: string; kind: string }>
  events: string[]
  enqueued: Array<{ topic: string; idempotencyKey?: string }>
}

const makeDeps = (state: Recorded, opts: { throwOnEvent?: boolean } = {}) => {
  const deps = {
    prisma: {
      budgetAlert: {
        createMany: async ({
          data,
        }: {
          data: Array<{ scopeType: string; scopeId: string; periodStart: Date; kind: string }>
        }) => {
          let count = 0
          for (const row of data) {
            const key = `${row.scopeType}:${row.scopeId}:${row.periodStart.toISOString()}:${row.kind}`
            if (state.alerts.some((a) => `${a.scopeType}:${a.scopeId}:${a.periodStart}:${a.kind}` === key)) {
              continue
            }
            state.alerts.push({
              scopeType: row.scopeType,
              scopeId: row.scopeId,
              periodStart: row.periodStart.toISOString(),
              kind: row.kind,
            })
            count += 1
          }
          return { count }
        },
      },
      taskEvent: {
        create: async ({ data }: { data: { eventType: string } }) => {
          if (opts.throwOnEvent) throw new Error('taskEvent boom')
          state.events.push(data.eventType)
          return {}
        },
      },
      organization: { findUnique: async () => ({ name: 'Acme' }) },
      project: { findUnique: async () => ({ name: 'Proj' }) },
      team: { findUnique: async () => ({ name: 'Squad' }) },
    },
    queueProvider: {
      enqueue: async (topic: string, _payload: unknown, options?: { idempotencyKey?: string }) => {
        state.enqueued.push({ topic, idempotencyKey: options?.idempotencyKey })
        return 'job-1'
      },
    },
  } as unknown as ExecutionDependencies
  return deps
}

const context = { run: { id: 'run-1' }, task: { id: 'task-1' } } as unknown as RunContext

const evaluation = (
  alert: BudgetAlertSnapshot | null,
  decision: BudgetEvaluation['decision'] = { action: 'allow' },
): BudgetEvaluation => ({ alert, decision })

test('threshold crossing fires exactly once per period (durable dedupe)', async () => {
  const state: Recorded = { alerts: [], events: [], enqueued: [] }
  const deps = makeDeps(state)

  await maybeEmitBudgetAlerts(deps, context, evaluation(snapshot()))
  await maybeEmitBudgetAlerts(deps, context, evaluation(snapshot()))

  assert.equal(state.events.length, 1)
  assert.equal(state.events[0], 'budget.threshold_alert')
  assert.equal(state.enqueued.length, 1)
  assert.equal(state.enqueued[0]?.topic, 'budget.alert-dispatch')
  assert.match(state.enqueued[0]?.idempotencyKey ?? '', /^budget-alert:organization:org-1:.*:threshold$/)
})

test('no alert below the warn threshold', async () => {
  const state: Recorded = { alerts: [], events: [], enqueued: [] }
  const deps = makeDeps(state)

  await maybeEmitBudgetAlerts(deps, context, evaluation(snapshot({ level: 'ok', percentUsed: 40, spentUsd: 40 })))

  assert.equal(state.events.length, 0)
  assert.equal(state.enqueued.length, 0)
})

test('a blocked run emits a distinct blocked alert alongside the threshold one', async () => {
  const state: Recorded = { alerts: [], events: [], enqueued: [] }
  const deps = makeDeps(state)

  await maybeEmitBudgetAlerts(
    deps,
    context,
    evaluation(snapshot({ level: 'over', percentUsed: 120, spentUsd: 120 }), {
      action: 'block',
      reason: 'Monthly cost budget exceeded ($120.00 of $100.00)',
    }),
  )

  const kinds = state.enqueued
    .map((e) => e.idempotencyKey?.split(':').pop())
    .sort()
  assert.deepEqual(kinds, ['blocked', 'threshold'])
  assert.equal(state.events.length, 2)
})

test('emission is best-effort: a write failure never throws', async () => {
  const state: Recorded = { alerts: [], events: [], enqueued: [] }
  const deps = makeDeps(state, { throwOnEvent: true })

  await assert.doesNotReject(
    maybeEmitBudgetAlerts(deps, context, evaluation(snapshot())),
  )
})

test('no snapshot means nothing is emitted', async () => {
  const state: Recorded = { alerts: [], events: [], enqueued: [] }
  const deps = makeDeps(state)

  await maybeEmitBudgetAlerts(deps, context, evaluation(null))

  assert.equal(state.events.length, 0)
  assert.equal(state.enqueued.length, 0)
})
