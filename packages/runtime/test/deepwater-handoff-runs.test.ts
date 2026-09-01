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
  persistDeepWaterHandoffReportSources,
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
  connector_transport_config: {
    transport: 'http',
    url: 'https://ledger.example/v1/mcp/deepwater',
  },
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
    [row({ result_json: { legacyDispatchEvidence: true } })],
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
        ledgerOrigin: 'https://ledger.example',
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
      ledgerOrigin: 'https://ledger.example',
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

test('terminal lookup tolerates a connector removed after completion', async () => {
  const prisma = {
    $queryRaw: async () => [row({
      connector_transport_config: null,
      status: 'completed',
    })],
  } as unknown as PrismaClient

  const lookup = await findDeepWaterHandoffRun(prisma, locator)
  assert.equal(lookup.kind, 'found')
  if (lookup.kind === 'found') {
    assert.equal(lookup.run.ledgerOrigin, null)
    assert.equal(lookup.run.startEligible, false)
  }
})

test('fresh lookup fails closed without a connector transport origin', async () => {
  const prisma = {
    $queryRaw: async () => [row({ connector_transport_config: null })],
  } as unknown as PrismaClient

  await assert.rejects(
    findDeepWaterHandoffRun(prisma, locator),
    /connector transport URL is missing/,
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
      ledgerOrigin: 'https://ledger.example',
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
  assert.match(text, /legacyDispatchEvidence/)
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

test('validated ticket persistence adds provenance and atomic replay guards', async () => {
  const queries: unknown[] = []
  const prisma = {
    $queryRaw: async (query: unknown) => {
      queries.push(query)
      return [{ id: row().id }]
    },
  } as unknown as PrismaClient
  const input = {
    ...locator,
    externalRunId: 'rs_ticket-123',
    reportUrl: 'https://ledger.example/v1/research/rs_ticket-123/report',
    runId: row().id as string,
    ticketStatus: 'running' as const,
    toolCallId: 'stable-call',
  }

  assert.equal(await persistDeepWaterHandoffTicket(prisma, input), true)
  const text = sqlText(queries[0])
  assert.match(text, /"external_run_id" =/)
  assert.match(text, /"status" = 'running'/)
  assert.match(text, /"status" IN \('running', 'needs_setup'\)/)
  assert.match(text, /WHEN "status" = 'needs_setup'/)
  assert.match(text, /- 'statusDetail'/)
  assert.match(text, /result_json/)
  assert.match(text, /reportUrlSource/)
  assert.match(text, /reportUrlSource.*<>/s)
  assert.match(text, /startToolCallId/)
  const values = (queries[0] as { values?: readonly unknown[] }).values ?? []
  assert.ok(values.includes('rs_ticket-123'))
  assert.ok(values.includes(JSON.stringify({
    reportUrl: 'https://ledger.example/v1/research/rs_ticket-123/report',
    reportUrlSource: 'ledger_research_start',
    startTicketStatus: 'running',
  })))
  assert.ok(values.includes('stable-call'))
})

test('report evidence persistence replaces untrusted data and rejects trusted conflicts', async () => {
  const queries: unknown[] = []
  const tx = {
    $executeRaw: async (input: unknown) => {
      queries.push(input)
      return 1
    },
    $queryRaw: async (input: unknown) => {
      queries.push(input)
      return [{ id: row().id }]
    },
  }
  const prisma = {
    $transaction: async <T>(operation: (client: typeof tx) => Promise<T>): Promise<T> =>
      operation(tx),
  } as unknown as PrismaClient

  assert.equal(await persistDeepWaterHandoffReportSources(prisma, {
    ...locator,
    externalRunId: 'rs_ticket-123',
    runId: row().id as string,
    sourceCount: 14,
  }), true)

  const updateText = sqlText(queries[0])
  const repairText = sqlText(queries[1])
  const values = (queries[0] as { values?: readonly unknown[] }).values ?? []
  assert.match(updateText, /"source_count" =/)
  assert.match(updateText, /sourceCountSource/)
  assert.match(updateText, /sourceCountSource.*<>/s)
  assert.match(updateText, /"source_count" = .*sourceCountSource/s)
  assert.match(repairText, /UPDATE "connector_usage_events"/)
  assert.match(repairText, /"correlation_id"/)
  assert.match(repairText, /"unit_type" = 'sources'/)
  assert.ok(values.includes(14))
  assert.ok(values.includes(JSON.stringify({
    sourceCountSource: 'ledger_research_report',
  })))
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
    reportUrl: null,
    runId: row().id as string,
    ticketStatus: 'failed',
    toolCallId: 'stable-call',
  }), true)

  const values = (query as { values?: readonly unknown[] }).values ?? []
  assert.ok(values.includes(JSON.stringify({ startTicketStatus: 'failed' })))
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
  assert.match(text, /legacyDispatchEvidence/)
  assert.match(text, /"source_count" IS NULL/)
  assert.match(text, /"knowledge_page_id" IS NULL/)
  assert.match(text, /NOT \(COALESCE\("result_json"/)
  assert.doesNotMatch(text, /"external_run_id"\s*=/)
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
