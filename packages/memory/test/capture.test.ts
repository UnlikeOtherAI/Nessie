import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import { captureThought } from '../src/capture.js'

type QueryResult = {
  rowCount?: number | null
  rows: Record<string, unknown>[]
}

const createPoolStub = (
  handler: (sql: string, params: unknown[] | undefined) => QueryResult | Promise<QueryResult>,
): Pool => ({
  query: async (sql: string, params?: unknown[]) => handler(sql, params),
} as unknown as Pool)

const createModelClientStub = () => ({
  chatJson: async () => ({}),
  embed: async () => [0.1, 0.2, 0.3],
})

test('captureThought scopes duplicate detection to the resolved audience', async () => {
  const queries: { params: unknown[] | undefined; sql: string }[] = []

  const pool = createPoolStub((sql, params) => {
    queries.push({ params, sql })

    if (sql.includes('SELECT id, metadata FROM thoughts')) {
      return {
        rows: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            metadata: null,
          },
        ],
      }
    }

    throw new Error(`Unexpected query: ${sql}`)
  })

  const result = await captureThought(
    {
      audienceId: '22222222-2222-2222-2222-222222222222',
      audienceType: 'channel',
      channelId: '22222222-2222-2222-2222-222222222222',
      content: 'Remember that the mobile rollout channel is invite-only.',
      organizationId: '33333333-3333-3333-3333-333333333333',
      ownerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      ownerType: 'user',
    },
    {
      modelClient: createModelClientStub(),
      pool,
    },
  )

  assert.equal(result.isDuplicate, true)
  assert.ok(
    queries.some(
      (query) =>
        query.sql.includes('resolve_thought_audience_type')
        && query.params?.[2] === 'channel'
        && query.params?.[3] === '22222222-2222-2222-2222-222222222222',
    ),
  )
})

test('captureThought writes canonical audience fields for private user memory', async () => {
  const queries: { params: unknown[] | undefined; sql: string }[] = []

  const pool = createPoolStub((sql, params) => {
    queries.push({ params, sql })

    if (sql.includes('SELECT id, metadata FROM thoughts')) {
      return { rows: [] }
    }

    if (sql.includes('INSERT INTO thoughts')) {
      return {
        rows: [
          {
            created_at: '2026-04-14T22:00:00.000Z',
            id: '44444444-4444-4444-4444-444444444444',
          },
        ],
      }
    }

    if (sql.includes('INSERT INTO thought_audit_logs')) {
      return { rowCount: 1, rows: [] }
    }

    throw new Error(`Unexpected query: ${sql}`)
  })

  const result = await captureThought(
    {
      content: 'I prefer to keep release notes short unless there is a migration.',
      organizationId: '33333333-3333-3333-3333-333333333333',
      ownerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      ownerType: 'user',
      visibility: 'private',
    },
    {
      modelClient: createModelClientStub(),
      pool,
    },
  )

  assert.equal(result.isDuplicate, false)
  assert.ok(
    queries.some(
      (query) =>
        query.sql.includes('INSERT INTO thoughts')
        && query.params?.[5] === 'user'
        && query.params?.[6] === 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        && query.params?.[12] === 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        && query.params?.[13] === 'private',
    ),
  )
})
