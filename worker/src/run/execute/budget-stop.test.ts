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
  ['iterations', 'iteration_limit', '12 reasoning steps'],
  ['tool_calls', 'tool_call_limit', '20 tool calls'],
  ['wallclock', 'time_limit', '90s'],
  ['tokens', 'token_limit', '50,000 tokens'],
  ['cost', 'cost_limit', '~$0.50'],
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
      assert.ok(notice.includes('limit') || notice.includes('guard'))
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

  await recordBudgetStopEvent(prisma, 'task-1', 'cost', STATS, false)

  assert.equal(created.length, 1)
  const data = (created[0] as { data: Record<string, unknown> }).data
  assert.equal(data.eventType, 'run.budget_exhausted')
  assert.equal(data.taskId, 'task-1')
  const payload = data.payload as Record<string, unknown>
  assert.equal(payload.stopReason, 'cost_limit')
  assert.equal(payload.rawReason, 'cost')
  assert.equal(payload.hadPartialText, false)
  assert.equal(payload.costCents, 50)
})
