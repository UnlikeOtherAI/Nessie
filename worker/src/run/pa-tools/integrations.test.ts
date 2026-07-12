import assert from 'node:assert/strict'
import test from 'node:test'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { runDeepWaterRunUpdateTool } from './integrations.js'

const ORG_ID = '8f3a5a00-0e64-4d10-a517-0d0b69c1d401'
const RUN_ID = '8f3a5a00-0e64-4d10-a517-0d0b69c1d801'
const TEAM_ID = '8f3a5a00-0e64-4d10-a517-0d0b69c1d501'
const USER_ID = '8f3a5a00-0e64-4d10-a517-0d0b69c1d301'
const CONNECTOR_ID = '8f3a5a00-0e64-4d10-a517-0d0b69c1d701'
const CHANNEL_ID = '8f3a5a00-0e64-4d10-a517-0d0b69c1d812'
const THREAD_ID = '8f3a5a00-0e64-4d10-a517-0d0b69c1d814'
const MESSAGE_ID = '8f3a5a00-0e64-4d10-a517-0d0b69c1d813'
const PAGE_ID = '8f3a5a00-0e64-4d10-a517-0d0b69c1d901'

const makeDeepWaterRunRow = () => ({
  id: RUN_ID,
  organization_id: ORG_ID,
  team_id: TEAM_ID,
  product_slug: 'deep-water',
  requested_by_user_id: USER_ID,
  connector_id: CONNECTOR_ID,
  channel_id: CHANNEL_ID,
  thread_id: THREAD_ID,
  message_id: MESSAGE_ID,
  external_run_id: 'dw-run-123',
  status: 'completed',
  title: 'Geothermal risk map',
  query_preview: 'Map geothermal risk across permitting, grid access, finance, and insurance.',
  input_json: {
    artifactDestination: 'knowledge_draft',
    depth: 'deep',
    outputTier: 'full',
    searchQuality: 'premium',
  },
  result_json: {
    reportUrl: 'https://deepwater.example/reports/dw-run-123',
    statusDetail: 'Report ready for review.',
  },
  cost_amount: '4.25',
  cost_currency: 'USD',
  source_count: 18,
  knowledge_page_id: PAGE_ID,
  requested_at: '2026-07-10T10:30:00.000Z',
  completed_at: '2026-07-10T10:45:00.000Z',
  created_at: '2026-07-10T10:30:00.000Z',
  updated_at: '2026-07-10T10:45:00.000Z',
})

const makeContext = (
  overrides: {
    agentKind?: 'personal_assistant' | 'shared'
    runRow?: ReturnType<typeof makeDeepWaterRunRow>
  } = {},
) => {
  const queries: unknown[] = []
  const ledgerEvents: unknown[] = []
  const resultUpdates: unknown[] = []
  const row = overrides.runRow ?? makeDeepWaterRunRow()
  const tx = {
    $executeRaw: async (query: unknown) => {
      resultUpdates.push(query)
      return 1
    },
    $queryRaw: async (query: unknown) => {
      queries.push({ query, transaction: true })
      return [row]
    },
    connectorUsageEvent: {
      create: async (input: unknown) => {
        ledgerEvents.push(input)
        return { id: 'ledger-event-1' }
      },
    },
  }
  const prisma = {
    $queryRaw: async (query: unknown) => {
      queries.push(query)
      return [row]
    },
    $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx),
  }

  const context = {
    actorContext: {
      actionContext: {},
      actor: { actorId: USER_ID, actorType: 'user' },
      tenant: {
        organizationId: ORG_ID,
        projectId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d902',
        teamId: TEAM_ID,
      },
    },
    agentId: 'agent-1',
    agentKind: overrides.agentKind ?? 'personal_assistant',
    channel: { id: CHANNEL_ID, organizationId: ORG_ID },
    prisma,
    realtimeTransport: {},
    run: {
      id: 'worker-run-1',
      messageId: MESSAGE_ID,
      threadId: THREAD_ID,
    },
  } as unknown as BuiltinToolRuntimeContext

  return { context, ledgerEvents, queries, resultUpdates }
}

test('deep_water_run_update writes terminal status projection', async () => {
  const { context, ledgerEvents, queries, resultUpdates } = makeContext()

  const result = await runDeepWaterRunUpdateTool(context, {
    currency: 'USD',
    externalRunId: 'dw-run-123',
    knowledgePageId: PAGE_ID,
    reportUrl: 'https://deepwater.example/reports/dw-run-123',
    runId: RUN_ID,
    sourceCount: 18,
    status: 'completed',
    statusDetail: 'Report ready for review.',
    totalCost: 4.25,
  })

  assert.equal(result.toolName, 'deep_water_run_update')
  assert.match(result.outputPreview, /status=completed/)
  assert.match(result.outputPreview, /18 sources/)
  assert.match(result.outputPreview, /4\.25 USD/)
  assert.match(result.outputPreview, /usage ledger recorded/)
  assert.equal(queries.length, 2)
  assert.equal(ledgerEvents.length, 1)
  assert.equal(resultUpdates.length, 1)
  assert.deepEqual(
    (ledgerEvents[0] as { data: { metadata: { productSlug: string }; operation: string } })
      .data.metadata.productSlug,
    'deep-water',
  )
  assert.equal(
    (ledgerEvents[0] as { data: { costAmount: number; operation: string; unitType: string } })
      .data.costAmount,
    4.25,
  )
  assert.equal(
    (ledgerEvents[0] as { data: { costAmount: number; operation: string; unitType: string } })
      .data.operation,
    'research.completed',
  )
  assert.equal(
    (ledgerEvents[0] as { data: { costAmount: number; operation: string; unitType: string } })
      .data.unitType,
    'sources',
  )
})

test('deep_water_run_update does not double-record an already ledgered run', async () => {
  const runRow = {
    ...makeDeepWaterRunRow(),
    result_json: {
      reportUrl: 'https://deepwater.example/reports/dw-run-123',
      statusDetail: 'Report ready for review.',
      usageLedgerCorrelationId: `deep-water:${RUN_ID}`,
      usageLedgerRecordedAt: '2026-07-10T10:46:00.000Z',
    },
  }
  const { context, ledgerEvents, resultUpdates } = makeContext({ runRow })

  const result = await runDeepWaterRunUpdateTool(context, {
    currency: 'USD',
    runId: RUN_ID,
    sourceCount: 18,
    status: 'completed',
    totalCost: 4.25,
  })

  assert.equal(result.toolName, 'deep_water_run_update')
  assert.doesNotMatch(result.outputPreview, /usage ledger recorded/)
  assert.equal(ledgerEvents.length, 0)
  assert.equal(resultUpdates.length, 0)
})

test('deep_water_run_update is available to a granted shared agent', async () => {
  const { context, ledgerEvents, queries, resultUpdates } = makeContext({ agentKind: 'shared' })

  const result = await runDeepWaterRunUpdateTool(context, {
    currency: 'USD',
    runId: RUN_ID,
    sourceCount: 18,
    status: 'completed',
    totalCost: 4.25,
  })

  assert.equal(result.toolName, 'deep_water_run_update')
  assert.match(result.outputPreview, /status=completed/)
  assert.equal(queries.length, 2)
  assert.equal(ledgerEvents.length, 1)
  assert.equal(resultUpdates.length, 1)
})

test('deep_water_run_update rejects unsupported status values', async () => {
  const { context, queries } = makeContext()

  await assert.rejects(
    () => runDeepWaterRunUpdateTool(context, { runId: RUN_ID, status: 'queued' }),
    /status must be one of/,
  )
  assert.equal(queries.length, 0)
})
