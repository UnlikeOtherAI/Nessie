import assert from 'node:assert/strict'
import test from 'node:test'
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

const createPoolStub = (
  handler: (sql: string, params: unknown[] | undefined) => QueryResult | Promise<QueryResult>,
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

const runContext: ConsolidationRunContext = {
  agent_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  channel_id: '11111111-1111-1111-1111-111111111111',
  finished_at: '2026-05-31T10:00:00.000Z',
  organization_id: '22222222-2222-2222-2222-222222222222',
  project_id: '33333333-3333-3333-3333-333333333333',
  run_status: 'completed',
  task_purpose: 'Plan the beta rollout constraints.',
  task_status: 'done',
  task_title: 'Beta rollout',
  team_id: '44444444-4444-4444-4444-444444444444',
  thread_id: '55555555-5555-5555-5555-555555555555',
}

const messages: ConsolidationThreadMessage[] = [
  {
    agent_id: null,
    content: 'We must keep the beta invite-only because support capacity is limited.',
    created_at: '2026-05-31T09:58:00.000Z',
    id: '66666666-6666-6666-6666-666666666666',
    role: 'user',
    user_id: '77777777-7777-7777-7777-777777777777',
  },
  {
    agent_id: runContext.agent_id,
    content: 'Plan agreed. The beta will ship Friday and remain invite-only.',
    created_at: '2026-05-31T10:00:00.000Z',
    id: '88888888-8888-8888-8888-888888888888',
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

test('consolidateRunMemories captures typed memories with source metadata', async () => {
  const insertedParams: unknown[][] = []
  let inserted = 0
  const pool = createPoolStub((sql, params) => {
    if (sql.includes('FROM runs AS r')) {
      return { rows: [runContext as unknown as Record<string, unknown>] }
    }

    if (sql.includes('FROM messages')) {
      return { rows: [...messages].reverse() as unknown as Record<string, unknown>[] }
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
            id: `99999999-9999-9999-9999-99999999999${inserted}`,
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
      runId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      taskId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      threadTailLimit: 8,
    },
    {
      modelClient: {
        chatJson: async () => ({ hasReasoning: false, type: 'decision' }),
        embed: async () => [0.1, 0.2, 0.3],
      },
      pool,
    },
  )

  assert.equal(result.skippedReason, undefined)
  assert.equal(result.captured.length, result.candidateCount)
  assert.ok(insertedParams.some((params) => params[20] === 'episodic'))
  assert.ok(insertedParams.some((params) => params[20] === 'semantic'))
  assert.ok(insertedParams.every((params) => params[6] === runContext.channel_id))
  assert.ok(
    insertedParams.every((params) =>
      String(params[16]).includes('post_run_consolidation'),
    ),
  )
})
