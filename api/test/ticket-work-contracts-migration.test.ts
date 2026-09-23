import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
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
  TICKET_WORK_MACHINE_HOLDING_STATUSES,
  TICKET_WORK_TERMINAL_STATUSES,
  TicketWorkPullRequestStateSchema,
  TicketWorkStateReasonSchema,
  TicketWorkStatusSchema,
  TicketWorkWakeReasonSchema,
} from '@nessie/schemas'

// The ticket-work vocabularies live twice: as Zod enums the code parses with,
// and as CHECK constraints the database refuses with. Either can gain a value
// the other lacks and nothing would notice until a write failed in production
// (or, worse, a value the code never expects was stored). So this requires
// every CHECK list, and the WHERE of each partial unique index, to be exactly
// its Zod list.
//
// It reads every migration in the order `migrate deploy` applies them and
// compares each constraint's LATEST definition. The documented way to add a
// value is a new migration that drops and re-adds the CHECK; comparing only
// the migration that first wrote it would fail that change, and the only ways
// back to green would be editing an applied migration or weakening this test.
// ticket-work-contracts-postgres.test.ts holds the same lists against the
// migrated database itself.

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = resolve(apiDir, 'prisma/migrations')
const CONTRACTS_MIGRATION = '20260923220000_ticket_work_contracts'

// Comments name the constraints in prose; only the executable text counts.
const executableSql = (sql: string): string =>
  sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')

const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^\d+_/.test(entry.name))
  .map((entry) => entry.name)
  .sort()
  .map((name) => ({
    name,
    sql: executableSql(readFileSync(resolve(migrationsDir, name, 'migration.sql'), 'utf8')),
  }))
const contractsSql = migrations.find((migration) => migration.name === CONTRACTS_MIGRATION)?.sql ?? ''
const schemaPrisma = readFileSync(resolve(apiDir, 'prisma/schema.prisma'), 'utf8')

/**
 * The text of the latest definition of a named constraint or index, from the
 * name to the end of its clause. Fails when no migration defines it, or when
 * the latest migration to mention it drops it without defining it again.
 */
const latestDefinition = (kind: 'constraint' | 'index', name: string): string => {
  const quoted = `"${name}"`
  const pattern = kind === 'constraint'
    ? new RegExp(String.raw`(DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?|CONSTRAINT\s+)${quoted}`, 'g')
    : new RegExp(
      String.raw`(DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(?:"public"\.)?|CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?)${quoted}`,
      'g',
    )
  let latest: { dropped: boolean; migration: string; rest: string } | null = null
  for (const migration of migrations) {
    for (const match of migration.sql.matchAll(pattern)) {
      latest = {
        dropped: /^DROP/i.test(match[1]!),
        migration: migration.name,
        rest: migration.sql.slice(match.index! + match[0].length),
      }
    }
  }
  assert.ok(latest, `${kind} ${name} is defined by a migration`)
  assert.equal(latest.dropped, false, `${kind} ${name} was dropped by ${latest.migration} and not defined again`)
  // A CHECK inside CREATE TABLE ends at the next constraint; any clause ends
  // at its statement's semicolon.
  const end = latest.rest.search(kind === 'constraint' ? /CONSTRAINT "|;/ : /;/)
  return end === -1 ? latest.rest : latest.rest.slice(0, end)
}
const constraintBody = (name: string): string => latestDefinition('constraint', name)
const indexBody = (name: string): string => latestDefinition('index', name)

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

test('the trigger enum gains the two types in Prisma, in a migration and in Zod', () => {
  const block = schemaPrisma.match(/enum AgentTriggerType \{([^}]*)\}/)
  assert.ok(block, 'enum AgentTriggerType is in schema.prisma')
  const prismaValues = block[1]!
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
  sameList(prismaValues, AgentTriggerTypeSchema.options, 'AgentTriggerType')
  for (const value of ['ticket_changed', 'document_changed']) {
    assert.match(contractsSql, new RegExp(`ALTER TYPE "AgentTriggerType" ADD VALUE IF NOT EXISTS '${value}'`))
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

  const [prStates] = inLists(constraintBody('agent_ticket_work_last_pr_state_known'), 'last_pr_state')
  sameList(prStates!, TicketWorkPullRequestStateSchema.options, 'last_pr_state')
})

test('each partial unique index covers exactly its statuses', () => {
  const oneLive = indexBody('agent_ticket_work_one_live')
  assert.match(oneLive, /ON "agent_ticket_work"\("trigger_id", "task_id"\)/)
  sameList(inLists(oneLive, 'status')[0]!, TICKET_WORK_LIVE_STATUSES, 'one_live WHERE')

  const perExecutor = indexBody('agent_ticket_work_one_per_executor')
  assert.match(perExecutor, /ON "agent_ticket_work"\("executor_id"\)/)
  assert.match(perExecutor, /"executor_id" IS NOT NULL/)
  sameList(inLists(perExecutor, 'status')[0]!, TICKET_WORK_MACHINE_HOLDING_STATUSES, 'one_per_executor WHERE')
  sameList(
    TICKET_WORK_MACHINE_HOLDING_STATUSES.filter((status) => TICKET_WORK_LIVE_STATUSES.includes(status)),
    TICKET_WORK_MACHINE_HOLDING_STATUSES,
    'only a live record holds a machine',
  )

  assert.match(
    indexBody('agent_reminders_one_pending_per_work'),
    /ON "agent_reminders"\("work_id"\)\s+WHERE "status" = 'pending' AND "work_id" IS NOT NULL/,
  )

  const binding = indexBody('executor_standing_policies_one_binding')
  assert.match(binding, /ON "executor_standing_policies"\("trigger_id"\)/)
  assert.match(binding, /"trigger_id" IS NOT NULL/)
  sameList(inLists(binding, 'status')[0]!, ['live', 'suspended'], 'one_binding WHERE')
  assert.match(
    indexBody('executor_standing_policies_one_preparing'),
    /ON "executor_standing_policies"\("trigger_id"\)\s+WHERE "status" = 'preparing' AND "trigger_id" IS NOT NULL/,
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

test('a later migration that drops and re-adds a CHECK is the one compared', () => {
  // The rule this file follows, pinned against a synthetic later migration so
  // the scan cannot silently fall back to the first definition.
  const later = executableSql([
    'ALTER TABLE "agent_ticket_work" DROP CONSTRAINT "agent_ticket_work_last_pr_state_known";',
    'ALTER TABLE "agent_ticket_work" ADD CONSTRAINT "agent_ticket_work_last_pr_state_known"',
    `  CHECK ("last_pr_state" IS NULL OR "last_pr_state" IN ('OPEN', 'CLOSED', 'MERGED', 'DRAFT'));`,
  ].join('\n'))
  migrations.push({ name: '99999999999999_probe', sql: later })
  try {
    const [states] = inLists(constraintBody('agent_ticket_work_last_pr_state_known'), 'last_pr_state')
    assert.deepEqual(states, ['OPEN', 'CLOSED', 'MERGED', 'DRAFT'])
    migrations[migrations.length - 1] = {
      name: '99999999999999_probe',
      sql: 'ALTER TABLE "agent_ticket_work" DROP CONSTRAINT IF EXISTS "agent_ticket_work_last_pr_state_known";',
    }
    assert.throws(() => constraintBody('agent_ticket_work_last_pr_state_known'), /dropped by 99999999999999_probe/)
  } finally {
    migrations.pop()
  }
})

test('the contracts migration is additive, so the previous release keeps serving through it', () => {
  // lint-migrations fails the tree on these without a drain-list entry; this
  // migration must never need one.
  for (const clause of [/\bDROP\s+COLUMN\b/i, /\bDROP\s+TABLE\b/i, /\bSET\s+NOT\s+NULL\b/i]) {
    assert.doesNotMatch(contractsSql, clause)
  }
})
