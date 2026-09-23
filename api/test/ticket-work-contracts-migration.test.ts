import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  AgentReminderCancelledReasonSchema,
  AgentReminderStatusSchema,
  AgentTriggerTypeSchema,
  ExecutorStandingPolicyEndedReasonSchema,
  ExecutorStandingPolicyStatusSchema,
  ExecutorStandingPolicySuspendedReasonSchema,
  TICKET_WORK_LIVE_STATUSES,
  TICKET_WORK_TERMINAL_STATUSES,
  TicketWorkStateReasonSchema,
  TicketWorkStatusSchema,
  TicketWorkWakeReasonSchema,
} from '@nessie/schemas'

// The ticket-work vocabularies live twice: as Zod enums the code parses with,
// and as CHECK constraints the database refuses with. Either can gain a value
// the other lacks and nothing would notice until a write failed in production
// (or, worse, a value the code never expects was stored). So this reads the
// migration that shipped and requires every CHECK list, and the live-status
// WHERE of the partial unique index, to be exactly its Zod list.

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const migrationSql = readFileSync(
  resolve(apiDir, 'prisma/migrations/20260923220000_ticket_work_contracts/migration.sql'),
  'utf8',
)
const schemaPrisma = readFileSync(resolve(apiDir, 'prisma/schema.prisma'), 'utf8')

// Comments name the constraints in prose; only the executable text counts.
const executable = migrationSql
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n')

/** The body of one named constraint, up to the next constraint or the table's end. */
const constraintBody = (name: string): string => {
  const start = executable.indexOf(`CONSTRAINT "${name}"`)
  assert.notEqual(start, -1, `constraint ${name} is in the migration`)
  const rest = executable.slice(start + name.length + 13)
  const end = rest.search(/CONSTRAINT "|\n\);/)
  return end === -1 ? rest : rest.slice(0, end)
}

/** Every `"column" IN (...)` list in a stretch of SQL, in order. */
const inLists = (sql: string, column: string): string[][] => {
  const lists: string[][] = []
  const pattern = new RegExp(`"${column}" IN \\(([^)]*)\\)`, 'g')
  for (const match of sql.matchAll(pattern)) {
    lists.push([...match[1]!.matchAll(/'([^']*)'/g)].map((value) => value[1]!))
  }
  return lists
}

const sameList = (actual: readonly string[], expected: readonly string[], label: string) => {
  assert.equal(new Set(actual).size, actual.length, `${label}: no duplicates`)
  assert.deepEqual([...actual].sort(), [...expected].sort(), label)
}

test('the trigger enum gains the two types in Prisma, in the migration and in Zod', () => {
  const block = schemaPrisma.match(/enum AgentTriggerType \{([^}]*)\}/)
  assert.ok(block, 'enum AgentTriggerType is in schema.prisma')
  const prismaValues = block[1]!
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
  sameList(prismaValues, AgentTriggerTypeSchema.options, 'AgentTriggerType')
  for (const value of ['ticket_changed', 'document_changed']) {
    assert.match(executable, new RegExp(`ALTER TYPE "AgentTriggerType" ADD VALUE IF NOT EXISTS '${value}'`))
  }
})

test('the work record CHECKs are the ticket-work Zod lists', () => {
  const [statuses] = inLists(constraintBody('agent_ticket_work_status_known'), 'status')
  sameList(statuses!, TicketWorkStatusSchema.options, 'status')
  sameList(
    [...TICKET_WORK_LIVE_STATUSES, ...TICKET_WORK_TERMINAL_STATUSES],
    TicketWorkStatusSchema.options,
    'live and terminal statuses partition the vocabulary',
  )

  const [stateReasons] = inLists(constraintBody('agent_ticket_work_state_reason_known'), 'state_reason')
  sameList(stateReasons!, TicketWorkStateReasonSchema.options, 'state_reason')

  const ended = constraintBody('agent_ticket_work_ended_known')
  const [live, terminal] = inLists(ended, 'status')
  sameList(live!, TICKET_WORK_LIVE_STATUSES, 'ended: live statuses')
  sameList(terminal!, TICKET_WORK_TERMINAL_STATUSES, 'ended: terminal statuses')
  const [endedReasons] = inLists(ended, 'ended_reason')
  sameList(endedReasons!, TicketWorkStateReasonSchema.options, 'ended_reason')

  const [wakeReasons] = inLists(constraintBody('agent_ticket_work_last_wake_reason_known'), 'last_wake_reason')
  sameList(wakeReasons!, TicketWorkWakeReasonSchema.options, 'last_wake_reason')
})

test('the one-live partial index covers exactly the live statuses', () => {
  const index = executable.match(/CREATE UNIQUE INDEX "agent_ticket_work_one_live"[\s\S]*?;/)
  assert.ok(index, 'agent_ticket_work_one_live exists')
  assert.match(index[0], /\("trigger_id", "task_id"\)/)
  const [live] = inLists(index[0], 'status')
  sameList(live!, TICKET_WORK_LIVE_STATUSES, 'one_live WHERE')

  assert.match(
    executable,
    /CREATE UNIQUE INDEX "agent_ticket_work_one_active_per_executor"\s+ON "agent_ticket_work"\("executor_id"\)\s+WHERE "status" = 'active'/,
  )
  assert.match(
    executable,
    /CREATE UNIQUE INDEX "agent_reminders_one_pending_per_work"\s+ON "agent_reminders"\("work_id"\)\s+WHERE "status" = 'pending' AND "work_id" IS NOT NULL/,
  )
})

test('the standing policy CHECKs are the policy Zod lists', () => {
  const [statuses] = inLists(constraintBody('executor_standing_policies_status_known'), 'status')
  sameList(statuses!, ExecutorStandingPolicyStatusSchema.options, 'policy status')
  const [suspended] = inLists(
    constraintBody('executor_standing_policies_suspended_reason_known'),
    'suspended_reason',
  )
  sameList(suspended!, ExecutorStandingPolicySuspendedReasonSchema.options, 'suspended_reason')
  const [endedReasons] = inLists(constraintBody('executor_standing_policies_ended_reason_known'), 'ended_reason')
  sameList(endedReasons!, ExecutorStandingPolicyEndedReasonSchema.options, 'policy ended_reason')

  const [positions] = [...constraintBody('executor_standing_policy_executors_position_known')
    .matchAll(/"position" IN \(([^)]*)\)/g)].map((match) => match[1]!.split(',').map((value) => value.trim()))
  assert.deepEqual(positions, ['0', '1'], 'a pool is one or two machines')
})

test('the reminder CHECK is the reminder Zod lists', () => {
  const body = constraintBody('agent_reminders_status_known')
  const statuses = [...body.matchAll(/"status" = '([^']*)'/g)].map((match) => match[1]!)
  sameList(statuses, AgentReminderStatusSchema.options, 'reminder status')
  const [cancelled] = inLists(body, 'cancelled_reason')
  sameList(cancelled!, AgentReminderCancelledReasonSchema.options, 'cancelled_reason')
})

test('the migration is additive, so the previous release keeps serving through it', () => {
  // lint-migrations fails the tree on these without a drain-list entry; this
  // migration must never need one.
  for (const clause of [/\bDROP\s+COLUMN\b/i, /\bDROP\s+TABLE\b/i, /\bSET\s+NOT\s+NULL\b/i]) {
    assert.doesNotMatch(executable, clause)
  }
})
