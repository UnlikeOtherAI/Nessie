import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { PrismaClient } from '@prisma/client'
import { Pool } from 'pg'

import {
  DeepWaterResearchRunConflictError,
  markDeepWaterResearchRunFailed,
  updateDeepWaterResearchRun,
  type DeepWaterResearchRunUpdateInput,
} from '../src/integration-runs.js'

const ORGANIZATION_ID = '8f3a5a00-0e64-4d10-a517-0d0b69c1d401'
const TEAM_ID = '8f3a5a00-0e64-4d10-a517-0d0b69c1d501'
const RUN_ID = '8f3a5a00-0e64-4d10-a517-0d0b69c1d801'
const USER_ID = '8f3a5a00-0e64-4d10-a517-0d0b69c1d301'
const CONNECTOR_ID = '8f3a5a00-0e64-4d10-a517-0d0b69c1d701'
const CHANNEL_ID = '8f3a5a00-0e64-4d10-a517-0d0b69c1d812'
const THREAD_ID = '8f3a5a00-0e64-4d10-a517-0d0b69c1d814'
const MESSAGE_ID = '8f3a5a00-0e64-4d10-a517-0d0b69c1d813'
const runIfDatabase = process.env.DATABASE_URL ? test : test.skip

type RunState = {
  cost_amount: string | null
  cost_currency: string | null
  external_run_id: string | null
  result_json?: Record<string, unknown>
  status: 'queued' | 'running' | 'needs_setup' | 'completed' | 'failed' | 'warning'
}

const makeRunRow = (state: RunState) => ({
  id: RUN_ID,
  organization_id: ORGANIZATION_ID,
  team_id: TEAM_ID,
  product_slug: 'deep-water',
  requested_by_user_id: USER_ID,
  connector_id: CONNECTOR_ID,
  channel_id: CHANNEL_ID,
  thread_id: THREAD_ID,
  message_id: MESSAGE_ID,
  external_run_id: state.external_run_id,
  status: state.status,
  title: 'Geothermal risk map',
  query_preview: 'Map geothermal risk.',
  input_json: {
    artifactDestination: 'knowledge_draft',
    depth: 'deep',
    outputTier: 'full',
    searchQuality: 'premium',
  },
  result_json: state.result_json ?? {},
  cost_amount: state.cost_amount,
  cost_currency: state.cost_currency,
  source_count: 18,
  knowledge_page_id: null,
  requested_at: '2026-07-10T10:30:00.000Z',
  completed_at:
    state.status === 'completed'
    || state.status === 'failed'
    || state.status === 'warning'
      ? '2026-07-10T10:45:00.000Z'
      : null,
  created_at: '2026-07-10T10:30:00.000Z',
  updated_at: '2026-07-10T10:45:00.000Z',
})

const updateInput = (
  overrides: Partial<DeepWaterResearchRunUpdateInput> = {},
): DeepWaterResearchRunUpdateInput => ({
  organizationId: ORGANIZATION_ID,
  runId: RUN_ID,
  teamId: TEAM_ID,
  threadId: THREAD_ID,
  ...overrides,
})

const sqlText = (query: unknown): string =>
  ((query as { strings?: readonly string[] }).strings ?? []).join('?')

const makePrisma = (state: RunState) => {
  const queries: string[] = []
  let updateCount = 0
  const tx = {
    $queryRaw: async (query: unknown) => {
      const text = sqlText(query)
      queries.push(text)
      if (text.includes('FOR UPDATE')) return [state]
      if (text.includes('UPDATE "product_integration_runs"')) {
        updateCount += 1
        return [makeRunRow(state)]
      }
      throw new Error(`Unexpected query: ${text}`)
    },
  }
  const prisma = {
    $transaction: async <T>(operation: (client: typeof tx) => Promise<T>): Promise<T> =>
      operation(tx),
    knowledgePage: { findFirst: async () => null },
  } as unknown as PrismaClient
  return {
    prisma,
    queries,
    updateCount: () => updateCount,
  }
}

runIfDatabase(
  'PostgreSQL accepts nullable parameters for running and terminal updates',
  async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    const prisma = new PrismaClient()
    const ids = {
      channel: randomUUID(),
      organization: randomUUID(),
      project: randomUUID(),
      run: randomUUID(),
      team: randomUUID(),
      thread: randomUUID(),
    }
    const externalRunId = `rs_${ids.run.replaceAll('-', '')}`

    try {
      await pool.query(
        `INSERT INTO organizations (id, name, created_at, updated_at)
         VALUES ($1, 'Deep Water SQL Regression', now(), now())`,
        [ids.organization],
      )
      await pool.query(
        `INSERT INTO projects (id, name, organization_id, created_at, updated_at)
         VALUES ($1, 'Deep Water SQL Regression', $2, now(), now())`,
        [ids.project, ids.organization],
      )
      await pool.query(
        `INSERT INTO teams (id, name, project_id, created_at, updated_at)
         VALUES ($1, 'Deep Water SQL Regression', $2, now(), now())`,
        [ids.team, ids.project],
      )
      await pool.query(
        `INSERT INTO channels (
           id, label, slug, organization_id, project_id, team_id, created_at, updated_at
         )
         VALUES ($1, 'Deep Water SQL Regression', $2, $3, $4, $5, now(), now())`,
        [
          ids.channel,
          `deep-water-sql-${ids.channel}`,
          ids.organization,
          ids.project,
          ids.team,
        ],
      )
      await pool.query(
        `INSERT INTO threads (id, channel_id, created_at, updated_at)
         VALUES ($1, $2, now(), now())`,
        [ids.thread, ids.channel],
      )
      await pool.query(
        `INSERT INTO product_integration_runs (
           id, organization_id, team_id, product_slug, thread_id, status,
           cost_currency, created_at, updated_at
         )
         VALUES ($1, $2, $3, 'deep-water', $4, 'queued', 'USD', now(), now())`,
        [ids.run, ids.organization, ids.team, ids.thread],
      )

      const running = await updateDeepWaterResearchRun(prisma, {
        externalRunId,
        organizationId: ids.organization,
        runId: ids.run,
        status: 'running',
        teamId: ids.team,
        threadId: ids.thread,
      })

      assert.equal(running.externalRunId, externalRunId)
      assert.equal(running.status, 'running')
      assert.equal(running.totalCost, null)

      const completedAt = new Date('2026-07-19T01:30:00.000Z')
      const completed = await updateDeepWaterResearchRun(prisma, {
        completedAt,
        costAmount: 1,
        costCurrency: 'USD',
        externalRunId,
        organizationId: ids.organization,
        runId: ids.run,
        sourceCount: 21,
        status: 'completed',
        teamId: ids.team,
        threadId: ids.thread,
      })

      assert.equal(completed.externalRunId, externalRunId)
      assert.equal(completed.status, 'completed')
      assert.equal(completed.totalCost, 1)
      assert.equal(completed.currency, 'USD')
      assert.equal(completed.sourceCount, 21)
      assert.equal(completed.completedAt, completedAt.toISOString())
    } finally {
      await prisma.$disconnect()
      await pool.query('DELETE FROM organizations WHERE id = $1', [ids.organization])
      await pool.end()
    }
  },
)

test('an identical terminal update is idempotent under a row lock', async () => {
  const fixture = makePrisma({
    cost_amount: '4.250000',
    cost_currency: 'USD',
    external_run_id: 'dw-run-123',
    status: 'completed',
  })

  const result = await updateDeepWaterResearchRun(fixture.prisma, updateInput({
    costAmount: 4.2500004,
    costCurrency: 'USD',
    externalRunId: 'dw-run-123',
    status: 'completed',
  }))

  assert.equal(result.status, 'completed')
  assert.equal(result.totalCost, 4.25)
  assert.equal(fixture.updateCount(), 1)
  assert.equal(fixture.queries.length, 2)
  assert.match(fixture.queries[0] ?? '', /FOR UPDATE/)
  assert.match(
    fixture.queries[1] ?? '',
    /COALESCE\(\s*"completed_at",\s+CAST\(\? AS timestamp\),\s+CURRENT_TIMESTAMP\s*\)/,
  )
})

const conflictScenarios = [
  {
    field: 'terminalStatus',
    name: 'terminal status regression',
    state: {
      cost_amount: '4.250000',
      cost_currency: 'USD',
      external_run_id: 'dw-run-123',
      status: 'completed',
    } satisfies RunState,
    update: { status: 'running' } satisfies Partial<DeepWaterResearchRunUpdateInput>,
  },
  {
    field: 'terminalStatus',
    name: 'terminal outcome replacement',
    state: {
      cost_amount: '4.250000',
      cost_currency: 'USD',
      external_run_id: 'dw-run-123',
      status: 'completed',
    } satisfies RunState,
    update: { status: 'failed' } satisfies Partial<DeepWaterResearchRunUpdateInput>,
  },
  {
    field: 'terminalStatus',
    name: 'completed start ticket projected as failed',
    state: {
      cost_amount: null,
      cost_currency: 'USD',
      external_run_id: 'dw-run-123',
      result_json: { startTicketStatus: 'complete' },
      status: 'running',
    } satisfies RunState,
    update: { status: 'failed' } satisfies Partial<DeepWaterResearchRunUpdateInput>,
  },
  {
    field: 'terminalStatus',
    name: 'failed start ticket projected as completed',
    state: {
      cost_amount: null,
      cost_currency: 'USD',
      external_run_id: 'dw-run-123',
      result_json: { startTicketStatus: 'failed' },
      status: 'running',
    } satisfies RunState,
    update: { status: 'completed' } satisfies Partial<DeepWaterResearchRunUpdateInput>,
  },
  {
    field: 'externalRunId',
    name: 'external run id replacement',
    state: {
      cost_amount: null,
      cost_currency: 'USD',
      external_run_id: 'dw-run-123',
      status: 'running',
    } satisfies RunState,
    update: { externalRunId: 'dw-run-456' } satisfies Partial<DeepWaterResearchRunUpdateInput>,
  },
  {
    field: 'bookedCost',
    name: 'booked amount replacement',
    state: {
      cost_amount: '4.250000',
      cost_currency: 'USD',
      external_run_id: 'dw-run-123',
      status: 'completed',
    } satisfies RunState,
    update: {
      costAmount: 5,
      costCurrency: 'USD',
      status: 'completed',
    } satisfies Partial<DeepWaterResearchRunUpdateInput>,
  },
  {
    field: 'bookedCost',
    name: 'booked currency replacement',
    state: {
      cost_amount: '4.250000',
      cost_currency: 'USD',
      external_run_id: 'dw-run-123',
      status: 'completed',
    } satisfies RunState,
    update: {
      costAmount: 4.25,
      costCurrency: 'EUR',
      status: 'completed',
    } satisfies Partial<DeepWaterResearchRunUpdateInput>,
  },
] as const

for (const scenario of conflictScenarios) {
  test(`rejects ${scenario.name} without writing`, async () => {
    const fixture = makePrisma(scenario.state)

    await assert.rejects(
      () => updateDeepWaterResearchRun(
        fixture.prisma,
        updateInput(scenario.update),
      ),
      (error) =>
        error instanceof DeepWaterResearchRunConflictError
        && error.code === 'DEEP_WATER_RUN_IMMUTABLE_CONFLICT'
        && error.field === scenario.field,
    )

    assert.equal(fixture.updateCount(), 0)
    assert.equal(fixture.queries.length, 1)
    assert.match(fixture.queries[0] ?? '', /FOR UPDATE/)
  })
}

test('the first booked charge replaces the pre-booking currency placeholder', async () => {
  const state: RunState = {
    cost_amount: null,
    cost_currency: 'USD',
    external_run_id: 'dw-run-123',
    status: 'running',
  }
  const fixture = makePrisma(state)

  await updateDeepWaterResearchRun(fixture.prisma, updateInput({
    costAmount: 4.25,
    costCurrency: 'EUR',
    status: 'completed',
  }))

  assert.equal(fixture.updateCount(), 1)
  assert.match(
    fixture.queries[1] ?? '',
    /WHEN "cost_amount" IS NULL OR "cost_currency" IS NULL\s+THEN CAST\(\? AS text\)/,
  )
})

test('concurrent conflicting terminal updates serialize and only one wins', async () => {
  let state: RunState = {
    cost_amount: null,
    cost_currency: 'USD',
    external_run_id: null,
    status: 'running',
  }
  let updateCount = 0
  const lockQueries: string[] = []
  const tx = {
    $queryRaw: async (query: unknown) => {
      const text = sqlText(query)
      if (text.includes('FOR UPDATE')) {
        lockQueries.push(text)
        return [{ ...state }]
      }
      if (text.includes('UPDATE "product_integration_runs"')) {
        updateCount += 1
        state = {
          cost_amount: '4.250000',
          cost_currency: 'USD',
          external_run_id: 'dw-run-123',
          status: 'completed',
        }
        return [makeRunRow(state)]
      }
      throw new Error(`Unexpected query: ${text}`)
    },
  }
  let tail = Promise.resolve()
  const prisma = {
    $transaction: <T>(operation: (client: typeof tx) => Promise<T>): Promise<T> => {
      const result = tail.then(() => operation(tx))
      tail = result.then(() => undefined, () => undefined)
      return result
    },
    knowledgePage: { findFirst: async () => null },
  } as unknown as PrismaClient

  const [winner, conflict] = await Promise.allSettled([
    updateDeepWaterResearchRun(prisma, updateInput({
      costAmount: 4.25,
      costCurrency: 'USD',
      externalRunId: 'dw-run-123',
      status: 'completed',
    })),
    updateDeepWaterResearchRun(prisma, updateInput({
      costAmount: 5,
      costCurrency: 'USD',
      externalRunId: 'dw-run-123',
      status: 'completed',
    })),
  ])

  assert.equal(winner.status, 'fulfilled')
  assert.equal(conflict.status, 'rejected')
  assert.ok(
    conflict.status === 'rejected'
    && conflict.reason instanceof DeepWaterResearchRunConflictError
    && conflict.reason.field === 'bookedCost',
  )
  assert.equal(updateCount, 1)
  assert.equal(lockQueries.length, 2)
  assert.ok(lockQueries.every((query) => query.includes('FOR UPDATE')))
})

test('handoff failure cannot replace an existing terminal status', async () => {
  let statement = ''
  const prisma = {
    $executeRaw: async (query: unknown) => {
      statement = sqlText(query)
      return 0
    },
  } as unknown as PrismaClient

  await markDeepWaterResearchRunFailed(prisma, {
    organizationId: ORGANIZATION_ID,
    runId: RUN_ID,
  })

  assert.match(statement, /"status" NOT IN \('completed', 'failed', 'warning'\)/)
  assert.match(statement, /"completed_at" = COALESCE\("completed_at", CURRENT_TIMESTAMP\)/)
})
