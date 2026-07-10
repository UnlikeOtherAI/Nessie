import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import type { ModelClient } from '@nessie/runtime'
import { KNOWLEDGE_EMBEDDING_DIMS, KNOWLEDGE_EMBEDDING_MODEL } from '@nessie/schemas'
import { executeKnowledgeEmbedJob } from '../src/control/knowledge-embed.js'

type SqlLike = { sql: string; values: unknown[] }
type CapturedCall = { sql: string; values: unknown[] }

type PageRow = {
  id: string
  projectId: string
  teamId: string | null
  channelId: string | null
  threadId: string | null
}

const PAGE: PageRow = {
  id: '11111111-1111-1111-1111-111111111111',
  projectId: '22222222-2222-2222-2222-222222222222',
  teamId: '33333333-3333-3333-3333-333333333333',
  channelId: null,
  threadId: null,
}

const PAYLOAD = {
  organizationId: '44444444-4444-4444-4444-444444444444',
  pageId: PAGE.id,
  versionId: '55555555-5555-5555-5555-555555555555',
}

const buildPrismaStub = (opts: {
  page: PageRow | null
  pendingChunks: Array<{ id: string; content: string }>
  executeRawCalls: CapturedCall[]
  queryRawCalls: CapturedCall[]
}): PrismaClient =>
  ({
    knowledgePage: {
      findFirst: async () => opts.page,
    },
    $executeRaw: async (query: SqlLike) => {
      opts.executeRawCalls.push({ sql: query.sql, values: query.values })
      return 1
    },
    $queryRaw: async (query: SqlLike) => {
      opts.queryRawCalls.push({ sql: query.sql, values: query.values })
      if (query.sql.includes('SELECT id, content FROM knowledge_page_chunks')) {
        return opts.pendingChunks
      }
      return []
    },
  }) as unknown as PrismaClient

test('executeKnowledgeEmbedJob returns early with no writes when the page is missing', async () => {
  const executeRawCalls: CapturedCall[] = []
  const queryRawCalls: CapturedCall[] = []
  const prisma = buildPrismaStub({
    page: null,
    pendingChunks: [],
    executeRawCalls,
    queryRawCalls,
  })

  let embedManyCalls = 0
  const modelClient = {
    embedMany: async () => {
      embedManyCalls += 1
      return []
    },
  } as unknown as ModelClient

  await executeKnowledgeEmbedJob({ modelClient, prisma }, PAYLOAD)

  assert.equal(embedManyCalls, 0)
  assert.equal(executeRawCalls.length, 0)
  assert.equal(queryRawCalls.length, 0)
})

test('executeKnowledgeEmbedJob makes no model calls when the copy step satisfies every chunk', async () => {
  const executeRawCalls: CapturedCall[] = []
  const queryRawCalls: CapturedCall[] = []
  const prisma = buildPrismaStub({
    page: PAGE,
    pendingChunks: [],
    executeRawCalls,
    queryRawCalls,
  })

  let embedManyCalls = 0
  const modelClient = {
    embedMany: async () => {
      embedManyCalls += 1
      return []
    },
  } as unknown as ModelClient

  await executeKnowledgeEmbedJob({ modelClient, prisma }, PAYLOAD)

  assert.equal(embedManyCalls, 0)
  // copy step + stale-version delete, no batch UPDATE
  assert.equal(executeRawCalls.length, 2)
  assert.ok(executeRawCalls[0]!.sql.includes('SELECT DISTINCT ON'))
  assert.ok(executeRawCalls[1]!.sql.includes('DELETE FROM knowledge_page_chunks'))
})

test('executeKnowledgeEmbedJob batches embedding calls at 64 chunks and cleans up stale versions', async () => {
  const pendingChunks = Array.from({ length: 70 }, (_, i) => ({
    id: `chunk-${i}`,
    content: `content ${i}`,
  }))
  const executeRawCalls: CapturedCall[] = []
  const queryRawCalls: CapturedCall[] = []
  const prisma = buildPrismaStub({
    page: PAGE,
    pendingChunks,
    executeRawCalls,
    queryRawCalls,
  })

  const batchSizes: number[] = []
  const modelClient = {
    embedMany: async (texts: string[]) => {
      batchSizes.push(texts.length)
      return texts.map(() => Array<number>(KNOWLEDGE_EMBEDDING_DIMS).fill(0.1))
    },
  } as unknown as ModelClient

  await executeKnowledgeEmbedJob({ modelClient, prisma }, PAYLOAD)

  assert.deepEqual(batchSizes, [64, 6])
  // copy step + 2 batch UPDATEs + stale-version delete
  assert.equal(executeRawCalls.length, 4)
  const updateCalls = executeRawCalls.filter((c) => c.sql.includes('embedding = v.embedding::vector'))
  assert.equal(updateCalls.length, 2)
  for (const call of updateCalls) {
    assert.ok(call.values.includes(KNOWLEDGE_EMBEDDING_MODEL))
    assert.ok(call.values.includes(KNOWLEDGE_EMBEDDING_DIMS))
  }
  assert.ok(executeRawCalls.at(-1)!.sql.includes('DELETE FROM knowledge_page_chunks'))
})

test('executeKnowledgeEmbedJob skips vectors with the wrong dims without throwing', async () => {
  const pendingChunks = [
    { id: 'good-chunk', content: 'ok' },
    { id: 'bad-chunk', content: 'bad' },
  ]
  const executeRawCalls: CapturedCall[] = []
  const queryRawCalls: CapturedCall[] = []
  const prisma = buildPrismaStub({
    page: PAGE,
    pendingChunks,
    executeRawCalls,
    queryRawCalls,
  })

  const modelClient = {
    embedMany: async () => [
      Array<number>(KNOWLEDGE_EMBEDDING_DIMS).fill(0.1),
      Array<number>(KNOWLEDGE_EMBEDDING_DIMS - 1).fill(0.1),
    ],
  } as unknown as ModelClient

  const originalConsoleError = console.error
  const errorLogs: unknown[] = []
  console.error = (...args: unknown[]) => {
    errorLogs.push(args)
  }

  try {
    await assert.doesNotReject(executeKnowledgeEmbedJob({ modelClient, prisma }, PAYLOAD))
  } finally {
    console.error = originalConsoleError
  }

  assert.equal(errorLogs.length, 1)

  const updateCall = executeRawCalls.find((c) => c.sql.includes('embedding = v.embedding::vector'))
  assert.ok(updateCall)
  assert.ok(updateCall!.values.includes('good-chunk'))
  assert.ok(!updateCall!.values.includes('bad-chunk'))
})
