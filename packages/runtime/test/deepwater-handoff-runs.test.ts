import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  claimDeepWaterHandoffStart,
  DEEP_WATER_START_FAILURE_DETAIL,
  DEEP_WATER_START_RECOVERY_DETAIL,
  failDeepWaterHandoffStart,
  findDeepWaterHandoffRun,
  markAmbiguousDeepWaterHandoffRecoveryNeeded,
  markDeepWaterHandoffRecoveryNeeded,
  persistDeepWaterHandoffTicket,
} from '../src/deepwater-handoff-runs.js'

const locator = {
  messageId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d813',
  organizationId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d401',
  runId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d801',
  teamId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d501',
  threadId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d814',
}

const row = (overrides: Record<string, unknown> = {}) => ({
  cost_amount: null,
  external_run_id: null,
  id: '8f3a5a00-0e64-4d10-a517-0d0b69c1d801',
  knowledge_page_id: null,
  result_json: {},
  source_count: null,
  status: 'queued',
  ...overrides,
})

const sqlText = (query: unknown): string =>
  ((query as { strings?: readonly string[] }).strings ?? []).join('?')

test('handoff lookup rejects ambiguity', async () => {
  const rows = [
    row(),
    row({ id: '8f3a5a00-0e64-4d10-a517-0d0b69c1d802' }),
  ]
  const prisma = { $queryRaw: async () => rows } as unknown as PrismaClient
  assert.deepEqual(await findDeepWaterHandoffRun(prisma, locator), {
    kind: 'ambiguous',
  })
})

test('handoff lookup preserves provider evidence as failure-ineligible', async () => {
  for (const rows of [
    [row({ external_run_id: 'rs_existing' })],
    [row({ cost_amount: '1.00' })],
    [row({ knowledge_page_id: '8f3a5a00-0e64-4d10-a517-0d0b69c1d901' })],
    [row({ result_json: { reportUrl: null } })],
    [row({ result_json: { reportUrl: 'https://ledger.example/report' } })],
    [row({ status: 'completed' })],
  ]) {
    const prisma = { $queryRaw: async () => rows } as unknown as PrismaClient
    const externalRunId = rows[0]?.external_run_id as string | null
    assert.deepEqual(await findDeepWaterHandoffRun(prisma, locator), {
      kind: 'found',
      run: {
        externalRunId,
        failureEligible: false,
        id: row().id,
        startArguments: null,
        startEligible: false,
        startTicketStatus: null,
        startToolCallId: null,
        status: rows[0]?.status,
      },
    })
  }
})

test('handoff lookup returns one exact clean attached run', async () => {
  let query: unknown
  const prisma = {
    $queryRaw: async (input: unknown) => {
      query = input
      return [row()]
    },
  } as unknown as PrismaClient

  assert.deepEqual(await findDeepWaterHandoffRun(prisma, locator), {
    kind: 'found',
    run: {
      externalRunId: null,
      failureEligible: true,
      id: row().id,
      startArguments: null,
      startEligible: true,
      startTicketStatus: null,
      startToolCallId: null,
      status: 'queued',
    },
  })
  const queryText = sqlText(query)
  assert.match(queryText, /"message_id" =/)
  assert.match(queryText, /"id" =/)
  assert.match(queryText, /"organization_id" =/)
  assert.match(queryText, /"team_id" =/)
  assert.match(queryText, /"thread_id" =/)
  assert.match(queryText, /LIMIT 2/)
  assert.ok(
    (query as { values?: readonly unknown[] }).values?.includes(locator.runId),
  )
})

test('handoff lookup exposes exact correlation and arguments for crash recovery', async () => {
  const startArguments = { query: 'Original query', depth: 'deep' }
  const prisma = {
    $queryRaw: async () => [row({
      result_json: { startArguments, startToolCallId: 'stable-call' },
      status: 'running',
    })],
  } as unknown as PrismaClient

  assert.deepEqual(await findDeepWaterHandoffRun(prisma, locator), {
    kind: 'found',
    run: {
      externalRunId: null,
      failureEligible: true,
      id: row().id,
      startArguments,
      startEligible: false,
      startTicketStatus: null,
      startToolCallId: 'stable-call',
      status: 'running',
    },
  })
})

test('start claim permits only the first exact clean queued transition', async () => {
  let delivery = 0
  const queries: unknown[] = []
  const prisma = {
    $queryRaw: async (query: unknown) => {
      queries.push(query)
      delivery += 1
      return delivery === 1 ? [{ id: row().id }] : []
    },
  } as unknown as PrismaClient
  const input = {
    ...locator,
    args: { query: 'Original query', depth: 'deep' },
    runId: row().id as string,
    toolCallId: 'stable-call',
  }

  assert.equal(await claimDeepWaterHandoffStart(prisma, input), true)
  assert.equal(await claimDeepWaterHandoffStart(prisma, input), false)
  const text = sqlText(queries[0])
  assert.match(text, /"status" = 'running'/)
  assert.match(text, /"status" = 'queued'/)
  assert.match(text, /"external_run_id" IS NULL/)
  assert.match(text, /"cost_amount" IS NULL/)
  assert.match(text, /"knowledge_page_id" IS NULL/)
  assert.match(text, /startToolCallId/)
  assert.match(text, /startArguments/)
  assert.ok(
    (queries[0] as { values?: readonly unknown[] }).values?.includes('stable-call'),
  )
  assert.ok(
    (queries[0] as { values?: readonly unknown[] }).values?.includes(
      JSON.stringify(input.args),
    ),
  )
})

test('validated ticket persistence accepts late final-recovery tickets exactly once', async () => {
  const queries: unknown[] = []
  let delivery = 0
  const prisma = {
    $queryRaw: async (query: unknown) => {
      queries.push(query)
      delivery += 1
      return delivery === 1 ? [{ id: row().id }] : []
    },
  } as unknown as PrismaClient
  const input = {
    ...locator,
    externalRunId: 'rs_ticket-123',
    runId: row().id as string,
    ticketStatus: 'running' as const,
    toolCallId: 'stable-call',
  }

  assert.equal(await persistDeepWaterHandoffTicket(prisma, input), true)
  assert.equal(await persistDeepWaterHandoffTicket(prisma, input), false)
  const text = sqlText(queries[0])
  assert.match(text, /"external_run_id" =/)
  assert.match(text, /"status" = 'running'/)
  assert.match(text, /"status" IN \('running', 'needs_setup'\)/)
  assert.match(text, /WHEN "status" = 'needs_setup'/)
  assert.match(text, /- 'statusDetail'/)
  assert.match(text, /startTicketStatus/)
  assert.match(text, /startToolCallId/)
  const values = (queries[0] as { values?: readonly unknown[] }).values ?? []
  assert.ok(values.includes('rs_ticket-123'))
  assert.ok(values.includes('running'))
  assert.ok(values.includes('stable-call'))
})

test('terminal replay ticket preserves status while keeping reconciliation active', async () => {
  let query: unknown
  const prisma = {
    $queryRaw: async (input: unknown) => {
      query = input
      return [{ id: row().id }]
    },
  } as unknown as PrismaClient

  assert.equal(await persistDeepWaterHandoffTicket(prisma, {
    ...locator,
    externalRunId: 'rs_terminal',
    runId: row().id as string,
    ticketStatus: 'failed',
    toolCallId: 'stable-call',
  }), true)

  const values = (query as { values?: readonly unknown[] }).values ?? []
  assert.ok(values.includes('failed'))
  assert.match(sqlText(query), /"status" = 'running'/)
  assert.doesNotMatch(sqlText(query), /"completed_at" =/)
})

test('final-attempt recovery quarantines one exact clean queued or running row', async () => {
  const queries: unknown[] = []
  const prisma = {
    $queryRaw: async (query: unknown) => {
      queries.push(query)
      return [{ id: row().id }]
    },
  } as unknown as PrismaClient

  assert.equal(await markDeepWaterHandoffRecoveryNeeded(prisma, {
    ...locator,
    runId: row().id as string,
  }), true)
  const text = sqlText(queries[0])
  assert.match(text, /"status" = 'needs_setup'/)
  assert.match(text, /"status" IN \('queued', 'running'\)/)
  assert.match(text, /"id" =/)
  assert.match(text, /"external_run_id" IS NULL/)
  assert.ok(
    (queries[0] as { values?: readonly unknown[] }).values?.includes(
      DEEP_WATER_START_RECOVERY_DETAIL,
    ),
  )
})

test('ambiguous attachment recovery quarantines every exact clean candidate', async () => {
  let query: unknown
  const prisma = {
    $queryRaw: async (input: unknown) => {
      query = input
      return [{ id: row().id }, { id: `${row().id}-duplicate` }]
    },
  } as unknown as PrismaClient

  assert.equal(
    await markAmbiguousDeepWaterHandoffRecoveryNeeded(prisma, locator),
    2,
  )
  const text = sqlText(query)
  assert.match(text, /"status" = 'needs_setup'/)
  assert.match(text, /"message_id" =/)
  assert.match(text, /"organization_id" =/)
  assert.match(text, /"team_id" =/)
  assert.match(text, /"thread_id" =/)
  assert.match(text, /"status" IN \('queued', 'running'\)/)
  assert.match(text, /"external_run_id" IS NULL/)
  assert.match(text, /WHERE "id" =/)
})

test('failure transition is exact, correlated, and accepts late recovery state', async () => {
  const queries: unknown[] = []
  let delivery = 0
  const prisma = {
    $queryRaw: async (query: unknown) => {
      queries.push(query)
      delivery += 1
      return delivery === 1 ? [{ id: row().id }] : []
    },
  } as unknown as PrismaClient
  const input = {
    ...locator,
    runId: row().id as string,
    toolCallId: 'stable-call',
  }

  assert.equal(await failDeepWaterHandoffStart(prisma, input), true)
  assert.equal(await failDeepWaterHandoffStart(prisma, input), false)

  const text = sqlText(queries[0])
  assert.match(text, /"status" = 'queued'/)
  assert.match(text, /"status" IN \('running', 'needs_setup'\)/)
  assert.match(text, /startToolCallId/)
  assert.match(text, /"external_run_id" IS NULL/)
  assert.match(text, /"cost_amount" IS NULL/)
  assert.match(text, /"source_count" IS NULL/)
  assert.match(text, /"knowledge_page_id" IS NULL/)
  assert.match(text, /NOT \(COALESCE\("result_json"/)
  assert.doesNotMatch(text, /"external_run_id"\s*=/)
  assert.doesNotMatch(text, /"cost_amount"\s*=/)
  assert.doesNotMatch(text, /"knowledge_page_id"\s*=/)
  assert.ok(
    (queries[0] as { values?: readonly unknown[] }).values?.includes(
      DEEP_WATER_START_FAILURE_DETAIL,
    ),
  )
  assert.ok(
    (queries[0] as { values?: readonly unknown[] }).values?.includes(
      'stable-call',
    ),
  )
})

test('pre-dispatch failure can only settle an uncorrelated queued row', async () => {
  let query: unknown
  const prisma = {
    $queryRaw: async (input: unknown) => {
      query = input
      return [{ id: row().id }]
    },
  } as unknown as PrismaClient

  assert.equal(await failDeepWaterHandoffStart(prisma, {
    ...locator,
    runId: row().id as string,
  }), true)

  const text = sqlText(query)
  assert.match(text, /AS text\) IS NULL/)
  assert.match(text, /"status" = 'queued'/)
  assert.match(text, /\? 'startToolCallId'/)
  assert.match(text, /\? 'startArguments'/)
})
