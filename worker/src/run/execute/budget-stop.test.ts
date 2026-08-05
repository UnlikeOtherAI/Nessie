import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { BudgetExhaustionReason } from '../agentic-loop.js'
import {
  buildBudgetStopNotice,
  classifyBudgetStop,
  recordBudgetStopEvent,
  type RunStopReason,
} from './budget-stop.js'

const STATS = {
  iterations: 12,
  toolCallsUsed: 20,
  totalTokensUsed: 50_000,
  totalCostCents: 50,
  wallclockMs: 90_000,
}

const CASES: Array<[BudgetExhaustionReason, RunStopReason, string]> = [
  ['iterations', 'iteration_limit', '12 steps'],
  ['tool_calls', 'tool_call_limit', '20 tool calls'],
  ['wallclock', 'time_limit', '90s'],
  ['tokens', 'token_limit', '50,000 tokens'],
  ['cost', 'cost_limit', 'its configured cost limit'],
  ['org_budget_blocked', 'org_budget_blocked', 'owners have been notified'],
  ['loop_detected', 'repeated_tool_calls', 'a repeated tool-call loop'],
]

test('classifyBudgetStop maps every raw loop reason to a classified stop', () => {
  for (const [raw, expected] of CASES) {
    assert.equal(classifyBudgetStop(raw), expected)
  }
})

test('buildBudgetStopNotice is always non-empty and names the limit + detail', () => {
  for (const [raw, , detail] of CASES) {
    for (const hadPartialText of [true, false]) {
      const notice = buildBudgetStopNotice(raw, STATS, hadPartialText)
      assert.ok(notice.trim().length > 0, `empty notice for ${raw}`)
      assert.ok(notice.includes(detail), `missing detail for ${raw}: ${notice}`)
    }
  }
})

// Local cost telemetry must never reach a member-visible chat message; it
// stays in the TaskEvent payload and /ops/usage.
test('buildBudgetStopNotice never exposes a currency figure', () => {
  for (const [raw] of CASES) {
    for (const hadPartialText of [true, false]) {
      for (const continuation of [
        { kind: 'none' } as const,
        { kind: 'reply' } as const,
        { kind: 'auto', part: 2 } as const,
      ]) {
        const notice = buildBudgetStopNotice(raw, STATS, hadPartialText, continuation)
        assert.doesNotMatch(notice, /[$€£]|\busd\b/i, `currency leaked for ${raw}: ${notice}`)
      }
    }
  }
})

test('buildBudgetStopNotice frames partial vs no-answer differently', () => {
  const partial = buildBudgetStopNotice('iterations', STATS, true)
  const empty = buildBudgetStopNotice('iterations', STATS, false)

  assert.ok(partial.includes('may be incomplete'))
  assert.ok(empty.includes('without producing an answer'))
  assert.notEqual(partial, empty)
})

test('buildBudgetStopNotice surfaces the continuation affordance', () => {
  assert.match(
    buildBudgetStopNotice('tokens', STATS, true, { kind: 'reply' }),
    /Reply to continue from the saved checkpoint\./,
  )
  assert.match(
    buildBudgetStopNotice('tokens', STATS, true, { kind: 'auto', part: 3 }),
    /Continuing automatically from a saved checkpoint \(part 3\)\./,
  )
  assert.match(
    buildBudgetStopNotice('org_budget_blocked', STATS, false),
    /paused by the organization's budget — owners have been notified/,
  )
})

test('recordBudgetStopEvent writes a classified run.budget_exhausted task event', async () => {
  const created: unknown[] = []
  const prisma = {
    taskEvent: {
      create: async (arg: unknown) => {
        created.push(arg)
        return arg
      },
    },
  } as unknown as PrismaClient

  await recordBudgetStopEvent(prisma, 'task-1', 'cost', STATS, false, 'checkpoint-1')

  assert.equal(created.length, 1)
  const data = (created[0] as { data: Record<string, unknown> }).data
  assert.equal(data.eventType, 'run.budget_exhausted')
  assert.equal(data.taskId, 'task-1')
  const payload = data.payload as Record<string, unknown>
  assert.equal(payload.stopReason, 'cost_limit')
  assert.equal(payload.rawReason, 'cost')
  assert.equal(payload.hadPartialText, false)
  assert.equal(payload.costCents, 50)
  assert.equal(payload.checkpointId, 'checkpoint-1')
})
