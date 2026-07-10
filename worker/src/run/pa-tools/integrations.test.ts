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
  overrides: { agentKind?: 'personal_assistant' | 'shared' } = {},
) => {
  const queries: unknown[] = []
  const prisma = {
    $queryRaw: async (query: unknown) => {
      queries.push(query)
      return [makeDeepWaterRunRow()]
    },
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

  return { context, queries }
}

test('deep_water_run_update writes terminal status projection', async () => {
  const { context, queries } = makeContext()

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
  assert.equal(queries.length, 1)
})

test('deep_water_run_update rejects non-PA callers before touching the database', async () => {
  const { context, queries } = makeContext({ agentKind: 'shared' })

  await assert.rejects(
    () => runDeepWaterRunUpdateTool(context, { runId: RUN_ID, status: 'completed' }),
    /only available to the Personal Assistant/,
  )
  assert.equal(queries.length, 0)
})

test('deep_water_run_update rejects unsupported status values', async () => {
  const { context, queries } = makeContext()

  await assert.rejects(
    () => runDeepWaterRunUpdateTool(context, { runId: RUN_ID, status: 'queued' }),
    /status must be one of/,
  )
  assert.equal(queries.length, 0)
})
