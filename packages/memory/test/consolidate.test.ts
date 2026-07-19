import assert from 'node:assert/strict'
import test from 'node:test'

import type { LedgerAttribution } from '@nessie/runtime'
import {
  MemoryConsolidationInferenceOriginSchema,
  MemoryConsolidationSourceSchema,
} from '@nessie/schemas'
import type { Pool } from 'pg'

import {
  consolidateRunMemories,
  selectConsolidationCandidates,
  type ConsolidationRunContext,
  type ConsolidationThreadMessage,
} from '../src/consolidate.js'

type QueryResult = {
  rowCount?: number | null
  rows: Record<string, unknown>[]
}

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001'
const PROJECT_ID = '00000000-0000-4000-8000-000000000002'
const LAUNCH_TEAM_ID = '00000000-0000-4000-8000-000000000003'
const CHANNEL_ID = '00000000-0000-4000-8000-000000000004'
const THREAD_ID = '00000000-0000-4000-8000-000000000005'
const TASK_ID = '00000000-0000-4000-8000-000000000006'
const SOURCE_RUN_ID = '00000000-0000-4000-8000-000000000007'
const PA_AGENT_ID = '00000000-0000-4000-8000-000000000008'
const USER_ID = '00000000-0000-4000-8000-000000000009'
const PA_SYSTEM_PROJECT_ID = '00000000-0000-4000-8000-00000000000a'
const PA_SYSTEM_TEAM_ID = '00000000-0000-4000-8000-00000000000b'
const SYSTEM_AGENT_ID = '09a86284-7325-5194-8163-0b5d813407f6'
const SYSTEM_RUN_ID = 'e59b3d88-7a3e-512a-a1a3-cc1680abe674'

const createPoolStub = (
  handler: (
    sql: string,
    params: unknown[] | undefined,
  ) => QueryResult | Promise<QueryResult>,
): Pool => {
  const query = async (sql: string, params?: unknown[]) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [] }
    }
    return handler(sql, params)
  }
  return {
    query,
    connect: async () => ({ query, release: () => undefined }),
  } as unknown as Pool
}

const origin = MemoryConsolidationInferenceOriginSchema.parse({
  actorId: SYSTEM_AGENT_ID,
  actorType: 'system',
  agentId: SYSTEM_AGENT_ID,
  agentKind: 'system',
  organizationId: ORGANIZATION_ID,
  userId: USER_ID,
  teamId: LAUNCH_TEAM_ID,
  projectId: PROJECT_ID,
  channelId: CHANNEL_ID,
  threadId: THREAD_ID,
  taskId: TASK_ID,
  runId: SYSTEM_RUN_ID,
  requestId: `memory-consolidation:${SOURCE_RUN_ID}`,
  correlationId: 'launch-correlation',
  systemComponent: 'memory-consolidation',
  toolCallId: `memory-consolidation:${SOURCE_RUN_ID}:capture`,
})

const source = MemoryConsolidationSourceSchema.parse({
  agentId: PA_AGENT_ID,
  organizationId: ORGANIZATION_ID,
  userId: USER_ID,
  teamId: LAUNCH_TEAM_ID,
  projectId: PROJECT_ID,
  channelId: CHANNEL_ID,
  threadId: THREAD_ID,
  taskId: TASK_ID,
})

const runContext: ConsolidationRunContext = {
  agent_id: PA_AGENT_ID,
  channel_id: CHANNEL_ID,
  finished_at: '2026-05-31T10:00:00.000Z',
  organization_id: ORGANIZATION_ID,
  project_id: PA_SYSTEM_PROJECT_ID,
  run_status: 'completed',
  task_purpose: 'Plan the beta rollout constraints.',
  task_status: 'done',
  task_title: 'Beta rollout',
  task_project_id: null,
  team_id: PA_SYSTEM_TEAM_ID,
  thread_id: THREAD_ID,
}

const messages: ConsolidationThreadMessage[] = [
  {
    agent_id: null,
    content: 'We must keep the beta invite-only because support capacity is limited.',
    created_at: '2026-05-31T09:58:00.000Z',
    id: '00000000-0000-4000-8000-00000000000c',
    role: 'user',
    user_id: '00000000-0000-4000-8000-00000000000d',
  },
  {
    agent_id: runContext.agent_id,
    content: 'Plan agreed. The beta will ship Friday and remain invite-only.',
    created_at: '2026-05-31T10:00:00.000Z',
    id: '00000000-0000-4000-8000-00000000000e',
    role: 'assistant',
    user_id: null,
  },
]

test('selectConsolidationCandidates emits bounded typed episodic and semantic memories', () => {
  const candidates = selectConsolidationCandidates(runContext, messages)

  assert.equal(candidates[0]?.memoryType, 'episodic')
  assert.ok(candidates.some((candidate) => candidate.memoryType === 'semantic'))
  assert.ok(candidates.length <= 5)
  assert.ok(
    candidates.some((candidate) => candidate.memoryCategory === 'reason'),
  )
})

test('captures in the PA channel while billing the immutable launch origin', async () => {
  const insertedParams: unknown[][] = []
  const modelUsage: LedgerAttribution[] = []
  let inserted = 0
  const pool = createPoolStub((sql, params) => {
    if (sql.includes('FROM runs AS r')) {
      return { rows: [runContext as unknown as Record<string, unknown>] }
    }

    if (sql.includes('FROM messages')) {
      return {
        rows: [...messages].reverse() as unknown as Record<string, unknown>[],
      }
    }

    if (sql.includes('SELECT id, metadata FROM thoughts')) {
      return { rows: [] }
    }

    if (sql.includes('INSERT INTO thoughts')) {
      inserted += 1
      insertedParams.push(params ?? [])
      return {
        rows: [
          {
            created_at: '2026-05-31T10:01:00.000Z',
            id: `99999999-9999-4999-8999-99999999999${inserted}`,
          },
        ],
      }
    }

    if (sql.includes('INSERT INTO thought_audit_logs')) {
      return { rowCount: 1, rows: [] }
    }

    throw new Error(`Unexpected query: ${sql}`)
  })

  const result = await consolidateRunMemories(
    {
      origin,
      runId: SOURCE_RUN_ID,
      source,
      taskId: TASK_ID,
      threadTailLimit: 8,
    },
    {
      modelClient: {
        chatJson: async (_messages, options) => {
          assert.ok(options?.usage)
          modelUsage.push(options.usage)
          return { hasReasoning: false, type: 'decision' }
        },
        embed: async (_text, options) => {
          assert.ok(options?.usage)
          modelUsage.push(options.usage)
          return [0.1, 0.2, 0.3]
        },
      },
      pool,
    },
  )

  assert.equal(result.skippedReason, undefined)
  assert.equal(result.captured.length, result.candidateCount)
  assert.ok(insertedParams.some((params) => params[20] === 'episodic'))
  assert.ok(insertedParams.some((params) => params[20] === 'semantic'))
  assert.ok(insertedParams.every((params) => params[6] === runContext.channel_id))
  assert.ok(insertedParams.every((params) => params[8] === PA_SYSTEM_PROJECT_ID))
  assert.ok(insertedParams.every((params) => params[9] === PA_SYSTEM_TEAM_ID))
  assert.ok(
    insertedParams.every((params) =>
      String(params[16]).includes('post_run_consolidation'),
    ),
  )
  assert.ok(modelUsage.length > 0)
  for (const usage of modelUsage) {
    assert.deepEqual(usage, origin)
  }
  assert.ok(modelUsage.every((usage) => usage.organizationId === ORGANIZATION_ID))
  assert.ok(modelUsage.every((usage) => usage.teamId === LAUNCH_TEAM_ID))
  assert.ok(modelUsage.every((usage) => usage.teamId !== PA_SYSTEM_TEAM_ID))
  assert.ok(modelUsage.every((usage) => usage.userId === USER_ID))
  assert.ok(modelUsage.every((usage) => usage.agentId === SYSTEM_AGENT_ID))
  assert.ok(modelUsage.every((usage) => usage.runId === SYSTEM_RUN_ID))
  assert.ok(modelUsage.every((usage) => usage.agentKind === 'system'))
  assert.ok(modelUsage.every((usage) => usage.toolCallId === origin.toolCallId))
})

test('organization mismatch skips before message or model access', async () => {
  let messageQueries = 0
  let modelCalls = 0
  const pool = createPoolStub((sql) => {
    if (sql.includes('FROM runs AS r')) {
      return {
        rows: [{
          ...runContext,
          organization_id: '00000000-0000-4000-8000-00000000000f',
        }],
      }
    }
    messageQueries += 1
    return { rows: [] }
  })

  const result = await consolidateRunMemories(
    {
      origin,
      runId: SOURCE_RUN_ID,
      source,
      taskId: TASK_ID,
    },
    {
      modelClient: {
        chatJson: async () => {
          modelCalls += 1
          return {}
        },
        embed: async () => {
          modelCalls += 1
          return []
        },
      },
      pool,
    },
  )

  assert.equal(result.skippedReason, 'source_organization_mismatch')
  assert.equal(messageQueries, 0)
  assert.equal(modelCalls, 0)
})

test('source locator mismatches skip before message or model access', async () => {
  const cases: Array<{
    expected: string
    run: ConsolidationRunContext
  }> = [
    {
      expected: 'source_agent_mismatch',
      run: {
        ...runContext,
        agent_id: '00000000-0000-4000-8000-00000000000f',
      },
    },
    {
      expected: 'source_thread_mismatch',
      run: {
        ...runContext,
        thread_id: '00000000-0000-4000-8000-00000000000f',
      },
    },
    {
      expected: 'source_channel_mismatch',
      run: {
        ...runContext,
        channel_id: '00000000-0000-4000-8000-00000000000f',
      },
    },
    {
      expected: 'source_project_mismatch',
      run: {
        ...runContext,
        task_project_id: '00000000-0000-4000-8000-00000000000f',
      },
    },
  ]

  for (const mismatch of cases) {
    let laterQueries = 0
    let modelCalls = 0
    const pool = createPoolStub((sql) => {
      if (sql.includes('FROM runs AS r')) {
        return {
          rows: [mismatch.run as unknown as Record<string, unknown>],
        }
      }
      laterQueries += 1
      return { rows: [] }
    })

    const result = await consolidateRunMemories(
      {
        origin,
        runId: SOURCE_RUN_ID,
        source,
        taskId: TASK_ID,
      },
      {
        modelClient: {
          chatJson: async () => {
            modelCalls += 1
            return {}
          },
          embed: async () => {
            modelCalls += 1
            return []
          },
        },
        pool,
      },
    )

    assert.equal(result.skippedReason, mismatch.expected)
    assert.equal(laterQueries, 0)
    assert.equal(modelCalls, 0)
  }
})
