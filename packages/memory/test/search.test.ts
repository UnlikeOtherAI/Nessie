import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import { searchAndLogThoughts } from '../src/search.js'

type QueryResult = {
  rowCount?: number | null
  rows: Record<string, unknown>[]
}

const createPoolStub = (
  handler: (sql: string, params: unknown[] | undefined) => QueryResult | Promise<QueryResult>,
): Pool => {
  const client = {
    query: async (sql: string, params?: unknown[]) => handler(sql, params),
    release: () => undefined,
  }

  return {
    connect: async () => client,
  } as unknown as Pool
}

test('searchAndLogThoughts logs hybrid recalls and attaches recall ids', async () => {
  const queries: { params: unknown[] | undefined; sql: string }[] = []
  const originalFetch = globalThis.fetch

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: [{ embedding: [0.25, 0.5, 0.75] }],
      }),
      {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      },
    )

  const pool = createPoolStub((sql, params) => {
    queries.push({ params, sql })

    if (sql === 'BEGIN' || sql === 'COMMIT') {
      return { rows: [] }
    }

    if (sql.includes('match_thoughts_hybrid')) {
      return {
        rows: [
          {
            content: 'Phone verification is required for KYC compliance.',
            created_at: '2026-04-08T20:00:00.000Z',
            id: '11111111-1111-1111-1111-111111111111',
            importance: 0.9,
            metadata: null,
            owner_type: 'user',
            similarity: 0.82,
            visibility: 'organization',
          },
        ],
      }
    }

    if (sql.includes('UPDATE thoughts')) {
      return { rowCount: 1, rows: [] }
    }

    if (sql.includes('INSERT INTO thought_recalls')) {
      return {
        rowCount: 1,
        rows: [
          {
            id: '22222222-2222-2222-2222-222222222222',
            rankPosition: 1,
            retrievalMode: 'hybrid',
            thoughtId: '11111111-1111-1111-1111-111111111111',
          },
        ],
      }
    }

    throw new Error(`Unexpected query: ${sql}`)
  })

  try {
    const results = await searchAndLogThoughts(
      {
        organizationId: '33333333-3333-3333-3333-333333333333',
        query: 'Why do we require phone verification?',
        userId: 'user-1',
      },
      {
        embedding: { apiKey: 'test-key' },
        pool,
      },
    )

    assert.equal(results.length, 1)
    assert.equal(results[0]?.recallId, '22222222-2222-2222-2222-222222222222')
    assert.ok(queries.some((query) => query.sql.includes('match_thoughts_hybrid')))
    assert.ok(
      queries.some(
        (query) =>
          query.sql.includes('INSERT INTO thought_recalls')
          && Array.isArray(query.params?.[7])
          && (query.params?.[7] as string[])[0] === 'hybrid',
      ),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('searchAndLogThoughts skips embeddings for lexical mode', async () => {
  let fetchCalled = false
  const originalFetch = globalThis.fetch

  globalThis.fetch = async () => {
    fetchCalled = true
    throw new Error('fetch should not be called for lexical search')
  }

  const pool = createPoolStub((sql) => {
    if (sql === 'BEGIN' || sql === 'COMMIT') {
      return { rows: [] }
    }

    if (sql.includes('match_thoughts_lexical')) {
      return {
        rows: [
          {
            content: 'The deploy pipeline uses GitHub Actions.',
            created_at: '2026-04-08T20:00:00.000Z',
            id: '44444444-4444-4444-4444-444444444444',
            importance: 0.5,
            metadata: null,
            owner_type: 'service',
            similarity: 0.61,
            visibility: 'organization',
          },
        ],
      }
    }

    if (sql.includes('UPDATE thoughts')) {
      return { rowCount: 1, rows: [] }
    }

    if (sql.includes('INSERT INTO thought_recalls')) {
      return {
        rowCount: 1,
        rows: [
          {
            id: '55555555-5555-5555-5555-555555555555',
            rankPosition: 1,
            retrievalMode: 'lexical',
            thoughtId: '44444444-4444-4444-4444-444444444444',
          },
        ],
      }
    }

    throw new Error(`Unexpected query: ${sql}`)
  })

  try {
    const results = await searchAndLogThoughts(
      {
        mode: 'lexical',
        organizationId: '33333333-3333-3333-3333-333333333333',
        query: 'deploy pipeline actions',
        userId: 'user-1',
      },
      {
        embedding: { apiKey: 'test-key' },
        pool,
      },
    )

    assert.equal(fetchCalled, false)
    assert.equal(results[0]?.retrievalMode, 'lexical')
  } finally {
    globalThis.fetch = originalFetch
  }
})
