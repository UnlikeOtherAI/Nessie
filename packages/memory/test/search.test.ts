import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import { searchAndLogThoughts, searchAndLogThoughtsInScopes } from '../src/search.js'

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
  let embeddedText: string | null = null

  const pool = createPoolStub((sql, params) => {
    queries.push({ params, sql })

    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
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
            contentId: '11111111-1111-1111-1111-111111111111',
            thoughtId: '11111111-1111-1111-1111-111111111111',
          },
        ],
      }
    }

    throw new Error(`Unexpected query: ${sql}`)
  })

  const results = await searchAndLogThoughts(
    {
      organizationId: '33333333-3333-3333-3333-333333333333',
      outputAudienceId: '66666666-6666-6666-6666-666666666666',
      outputAudienceType: 'channel',
      query: 'Why do we require phone verification?',
      userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    },
    {
      modelClient: {
        embed: async (text) => {
          embeddedText = text
          return [0.25, 0.5, 0.75]
        },
      },
      pool,
    },
  )

  assert.equal(embeddedText, 'Why do we require phone verification?')
  assert.equal(results.length, 1)
  assert.equal(results[0]?.recallId, '22222222-2222-2222-2222-222222222222')
  assert.ok(
    queries.some(
      (query) =>
        query.sql.includes('match_thoughts_hybrid')
        && query.params?.[4] === 'channel'
        && query.params?.[5] === '66666666-6666-6666-6666-666666666666',
    ),
  )
  assert.ok(
    queries.some(
      (query) =>
        query.sql.includes('INSERT INTO thought_recalls')
        && Array.isArray(query.params?.[1])
        && (query.params?.[1] as string[])[0] === 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        && Array.isArray(query.params?.[4])
        && (query.params?.[4] as string[])[0] === 'channel'
        && Array.isArray(query.params?.[10])
        && (query.params?.[10] as string[])[0] === 'hybrid',
    ),
  )
})

test('searchAndLogThoughtsInScopes queries the multi-scope function and logs scope-less recalls', async () => {
  const queries: { params: unknown[] | undefined; sql: string }[] = []
  let embeddingUsage: unknown = null

  const pool = createPoolStub((sql, params) => {
    queries.push({ params, sql })

    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [] }
    }

    if (sql.includes('match_thoughts_in_scopes')) {
      return {
        rows: [
          {
            content: 'The team agreed to ship the beta on Friday.',
            created_at: '2026-04-08T20:00:00.000Z',
            id: '11111111-1111-1111-1111-111111111111',
            importance: 0.7,
            metadata: null,
            owner_type: 'agent',
            similarity: 0.71,
            visibility: 'channel',
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
            contentId: '11111111-1111-1111-1111-111111111111',
            thoughtId: '11111111-1111-1111-1111-111111111111',
          },
        ],
      }
    }

    throw new Error(`Unexpected query: ${sql}`)
  })

  const results = await searchAndLogThoughtsInScopes(
    {
      audienceIds: ['66666666-6666-6666-6666-666666666666', '88888888-8888-8888-8888-888888888888'],
      audienceTypes: ['channel', 'team'],
      channelId: '66666666-6666-6666-6666-666666666666',
      projectId: '33333333-3333-4333-8333-333333333334',
      teamId: '33333333-3333-4333-8333-333333333335',
      threadId: '33333333-3333-4333-8333-333333333336',
      taskId: '33333333-3333-4333-8333-333333333337',
      runId: '33333333-3333-4333-8333-333333333338',
      agentId: '99999999-9999-9999-9999-999999999999',
      agentKind: 'personal_assistant',
      actorId: '99999999-9999-9999-9999-999999999999',
      actorType: 'agent',
      requestId: 'request-1',
      correlationId: 'correlation-1',
      organizationId: '33333333-3333-3333-3333-333333333333',
      query: 'When does the beta ship?',
      runningAgentId: '99999999-9999-9999-9999-999999999999',
      userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    },
    {
      modelClient: {
        embed: async (_text, options) => {
          embeddingUsage = options?.usage
          return [0.25, 0.5, 0.75]
        },
      },
      pool,
    },
  )

  assert.equal(results.length, 1)
  assert.equal(results[0]?.recallId, '22222222-2222-2222-2222-222222222222')
  assert.deepEqual(embeddingUsage, {
    organizationId: '33333333-3333-3333-3333-333333333333',
    userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    projectId: '33333333-3333-4333-8333-333333333334',
    teamId: '33333333-3333-4333-8333-333333333335',
    channelId: '66666666-6666-6666-6666-666666666666',
    sessionId: null,
    threadId: '33333333-3333-4333-8333-333333333336',
    taskId: '33333333-3333-4333-8333-333333333337',
    runId: '33333333-3333-4333-8333-333333333338',
    agentId: '99999999-9999-9999-9999-999999999999',
    agentKind: 'personal_assistant',
    actorId: '99999999-9999-9999-9999-999999999999',
    actorType: 'agent',
    requestId: 'request-1',
    correlationId: 'correlation-1',
  })

  // The multi-scope function receives the zipped audience arrays + running agent.
  assert.ok(
    queries.some(
      (query) =>
        query.sql.includes('match_thoughts_in_scopes')
        && Array.isArray(query.params?.[3])
        && (query.params?.[3] as string[])[0] === 'channel'
        && Array.isArray(query.params?.[4])
        && (query.params?.[4] as string[])[1] === '88888888-8888-8888-8888-888888888888'
        && query.params?.[5] === 'channel'
        && query.params?.[6] === '66666666-6666-6666-6666-666666666666'
        && query.params?.[7] === '99999999-9999-9999-9999-999999999999',
    ),
  )

  // Recalls are logged with a null output audience (multi-scope, not one scope).
  assert.ok(
    queries.some(
      (query) =>
        query.sql.includes('INSERT INTO thought_recalls')
        && Array.isArray(query.params?.[4])
        && (query.params?.[4] as Array<string | null>)[0] === null,
    ),
  )
})

test('searchAndLogThoughtsInScopes returns nothing when no scopes are accessible', async () => {
  const pool = createPoolStub((sql) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [] }
    }
    throw new Error(`Unexpected query: ${sql}`)
  })

  const results = await searchAndLogThoughtsInScopes(
    {
      audienceIds: [],
      audienceTypes: [],
      channelId: '66666666-6666-6666-6666-666666666666',
      organizationId: '33333333-3333-3333-3333-333333333333',
      query: 'anything',
      runningAgentId: '99999999-9999-9999-9999-999999999999',
      userId: null,
    },
    { modelClient: { embed: async () => [0.1] }, pool },
  )

  assert.equal(results.length, 0)
})

test('searchAndLogThoughts skips embeddings for lexical mode', async () => {
  let embedCalled = false
  const queries: { params: unknown[] | undefined; sql: string }[] = []

  const pool = createPoolStub((sql, params) => {
    queries.push({ params, sql })

    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
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
            contentId: '44444444-4444-4444-4444-444444444444',
            thoughtId: '44444444-4444-4444-4444-444444444444',
          },
        ],
      }
    }

    throw new Error(`Unexpected query: ${sql}`)
  })

  const results = await searchAndLogThoughts(
    {
      mode: 'lexical',
      organizationId: '33333333-3333-3333-3333-333333333333',
      outputAudienceId: '77777777-7777-7777-7777-777777777777',
      outputAudienceType: 'user',
      query: 'deploy pipeline actions',
      threshold: 0.55,
      userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    },
    {
      modelClient: {
        embed: async () => {
          embedCalled = true
          return [0.25, 0.5, 0.75]
        },
      },
      pool,
    },
  )

  assert.equal(embedCalled, false)
  assert.equal(results[0]?.retrievalMode, 'lexical')
  assert.ok(
    queries.some(
      (query) =>
        query.sql.includes('match_thoughts_lexical')
        && query.params?.[5] === 0.55,
    ),
  )
})
