import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import type { Pool } from 'pg'
import {
  enqueueRunMemoryConsolidation,
  executeRunMemoryConsolidationJob,
  MEMORY_CONSOLIDATION_TOPIC,
} from '../src/run/memory-consolidation.js'

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

test('enqueueRunMemoryConsolidation uses a per-run idempotency key', async () => {
  const calls: unknown[] = []
  const prisma = {
    $executeRaw: async (query: unknown) => {
      calls.push(query)
      return 1
    },
  } as Pick<PrismaClient, '$executeRaw'>

  const inserted = await enqueueRunMemoryConsolidation(prisma, {
    runId: '11111111-1111-1111-1111-111111111111',
    taskId: '22222222-2222-2222-2222-222222222222',
  })

  assert.equal(inserted, true)
  assert.equal(calls.length, 1)
  const sqlCall = calls[0] as { values?: unknown[] }
  assert.ok(sqlCall.values?.includes(MEMORY_CONSOLIDATION_TOPIC))
  assert.ok(
    sqlCall.values?.includes(
      'memory-run-consolidate:11111111-1111-1111-1111-111111111111',
    ),
  )
  assert.equal(MEMORY_CONSOLIDATION_TOPIC, 'memory.run.consolidate')
})

test('executeRunMemoryConsolidationJob runs bounded consolidation capture', async () => {
  let insertCount = 0
  const pool = createPoolStub((sql) => {
    if (sql.includes('FROM runs AS r')) {
      return {
        rows: [
          {
            agent_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            channel_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            finished_at: '2026-05-31T10:00:00.000Z',
            organization_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
            project_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
            run_status: 'completed',
            task_purpose: 'Capture durable rollout facts.',
            task_status: 'done',
            task_title: 'Rollout',
            team_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
            thread_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
          },
        ],
      }
    }

    if (sql.includes('FROM messages')) {
      return {
        rows: [
          {
            agent_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            content: 'The rollout must remain invite-only because capacity is limited.',
            created_at: '2026-05-31T10:00:00.000Z',
            id: '99999999-9999-9999-9999-999999999999',
            role: 'assistant',
            user_id: null,
          },
          {
            agent_id: null,
            content: 'Keep the rollout invite-only while capacity is limited.',
            created_at: '2026-05-31T09:59:00.000Z',
            id: '88888888-8888-8888-8888-888888888888',
            role: 'user',
            user_id: '77777777-7777-7777-7777-777777777777',
          },
        ],
      }
    }

    if (sql.includes('SELECT id, metadata FROM thoughts')) {
      return { rows: [] }
    }

    if (sql.includes('INSERT INTO thoughts')) {
      insertCount += 1
      return {
        rows: [
          {
            created_at: '2026-05-31T10:01:00.000Z',
            id: `11111111-1111-1111-1111-11111111111${insertCount}`,
          },
        ],
      }
    }

    if (sql.includes('INSERT INTO thought_audit_logs')) {
      return { rowCount: 1, rows: [] }
    }

    throw new Error(`Unexpected query: ${sql}`)
  })

  await executeRunMemoryConsolidationJob(
    {
      captureConfig: {
        modelClient: {
          chatJson: async () => ({ hasReasoning: false, type: 'constraint' }),
          embed: async () => [0.1, 0.2, 0.3],
        },
        pool,
      },
    },
    {
      runId: '12121212-1212-1212-1212-121212121212',
      taskId: '34343434-3434-3434-3434-343434343434',
    },
  )

  assert.ok(insertCount > 0)
  assert.ok(insertCount <= 5)
})
