import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { FusedRetrievalResult } from '@nessie/retrieval'
import {
  groupFusedChunksByPage,
  searchNativePagesHybrid,
  snippetAroundMatch,
  truncateSnippet,
} from '../src/native-search-hybrid.js'
import type { SpaceViewer, SpaceViewerAgentScopes } from '../src/access.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const pageA = '00000000-0000-4000-8000-000000000010'
const pageB = '00000000-0000-4000-8000-000000000011'
const now = new Date('2026-05-31T10:00:00.000Z')

type FakeChunkCandidate = {
  id: string
  createdAt: Date
  pageId: string
  content: string
  startOffset: number
  endOffset: number
}

const fusedResult = (
  id: string,
  pageId: string,
  content: string,
  similarity: number,
): FusedRetrievalResult<FakeChunkCandidate> => ({
  candidate: { id, createdAt: now, pageId, content, startOffset: 0, endOffset: content.length },
  lexicalRank: 1,
  outcomeScore: 0,
  recencyScore: 1,
  rrfScore: similarity,
  semanticRank: null,
  similarity,
})

test('groupFusedChunksByPage keeps at most 3 passages per page, best-scoring first', () => {
  const fused = [
    fusedResult('c1', pageA, 'first chunk', 0.9),
    fusedResult('c2', pageA, 'second chunk', 0.8),
    fusedResult('c3', pageA, 'third chunk', 0.7),
    fusedResult('c4', pageA, 'fourth chunk (dropped)', 0.6),
    fusedResult('c5', pageB, 'other page chunk', 0.5),
  ]

  const grouped = groupFusedChunksByPage(fused, 10)

  assert.deepEqual(grouped.map((g) => g.pageId), [pageA, pageB])
  assert.equal(grouped[0]?.passages.length, 3)
  assert.equal(grouped[0]?.score, 0.9)
  assert.deepEqual(
    grouped[0]?.passages.map((p) => p.content),
    ['first chunk', 'second chunk', 'third chunk'],
  )
  assert.equal(grouped[1]?.score, 0.5)
})

test('groupFusedChunksByPage orders pages by first (best) appearance and respects the limit', () => {
  const fused = [
    fusedResult('c1', pageB, 'best of B', 0.95),
    fusedResult('c2', pageA, 'best of A', 0.4),
  ]

  const grouped = groupFusedChunksByPage(fused, 1)

  assert.deepEqual(grouped.map((g) => g.pageId), [pageB])
})

test('truncateSnippet leaves short content untouched', () => {
  assert.equal(truncateSnippet('short content'), 'short content')
})

test('truncateSnippet truncates on a word boundary and appends an ellipsis', () => {
  const content = 'a'.repeat(50) + ' ' + 'b'.repeat(50)
  const snippet = truncateSnippet(content, 60)

  assert.equal(snippet, `${'a'.repeat(50)}…`)
  assert.ok(snippet.length <= 60 + 1)
})

test('snippetAroundMatch windows the snippet around a late match', () => {
  const content = 'filler words here '.repeat(30) + 'terraform drift remediation closes the loop'
  const snippet = snippetAroundMatch(content, 'terraform drift', 120)

  assert.ok(snippet.includes('terraform'), snippet)
  assert.ok(snippet.startsWith('…'))
  assert.ok(snippet.length <= 121)
})

test('snippetAroundMatch falls back to head truncation without a literal match', () => {
  const content = 'x'.repeat(40) + ' ' + 'y'.repeat(200)
  const snippet = snippetAroundMatch(content, 'unrelated semantic query', 60)

  assert.equal(snippet, truncateSnippet(content, 60))
})

test('snippetAroundMatch keeps early matches on the head-truncation path', () => {
  const content = 'terraform appears immediately ' + 'z'.repeat(400)
  const snippet = snippetAroundMatch(content, 'terraform', 80)

  assert.ok(snippet.includes('terraform'))
  assert.ok(!snippet.startsWith('…'))
})

test('searchNativePagesHybrid issues only the lexical query when queryEmbedding is null', async () => {
  const queries: string[] = []
  const prisma = {
    $queryRaw: async (query: { sql: string }) => {
      queries.push(query.sql)
      return []
    },
    knowledgePage: { findMany: async () => [] },
  } as unknown as PrismaClient

  const result = await searchNativePagesHybrid(prisma, {
    organizationId,
    query: 'runbook',
    queryEmbedding: null,
  })

  assert.equal(queries.length, 1)
  assert.match(queries[0] ?? '', /websearch_to_tsquery/)
  assert.deepEqual(result, { data: [], meta: { cursor: null, hasMore: false } })
})

test('searchNativePagesHybrid issues both channels when queryEmbedding is present', async () => {
  const queries: string[] = []
  const prisma = {
    $queryRaw: async (query: { sql: string }) => {
      queries.push(query.sql)
      return []
    },
    knowledgePage: { findMany: async () => [] },
  } as unknown as PrismaClient

  await searchNativePagesHybrid(prisma, {
    organizationId,
    query: 'runbook',
    queryEmbedding: [0.1, 0.2, 0.3],
  })

  assert.equal(queries.length, 2)
  assert.match(queries[0] ?? '', /websearch_to_tsquery/)
  assert.match(queries[1] ?? '', /embedding <=>/)
})

test('searchNativePagesHybrid filters chunks to a ticket when taskId is supplied', async () => {
  const queries: string[] = []
  const prisma = {
    $queryRaw: async (query: { sql: string }) => {
      queries.push(query.sql)
      return []
    },
    knowledgePage: { findMany: async () => [] },
  } as unknown as PrismaClient

  await searchNativePagesHybrid(prisma, {
    organizationId,
    query: 'runbook',
    queryEmbedding: null,
    taskId: '00000000-0000-4000-8000-000000000099',
  })

  assert.match(queries[0] ?? '', /AND c\.task_id = /)
})

test('searchNativePagesHybrid omits the taskId filter when not supplied', async () => {
  const queries: string[] = []
  const prisma = {
    $queryRaw: async (query: { sql: string }) => {
      queries.push(query.sql)
      return []
    },
    knowledgePage: { findMany: async () => [] },
  } as unknown as PrismaClient

  await searchNativePagesHybrid(prisma, {
    organizationId,
    query: 'runbook',
    queryEmbedding: null,
  })

  assert.doesNotMatch(queries[0] ?? '', /c\.task_id/)
})

const agentScopes = (overrides: Partial<SpaceViewerAgentScopes> = {}): SpaceViewerAgentScopes => ({
  id: '00000000-0000-4000-8000-000000000020',
  parentAgentId: null,
  orgBound: true,
  channelIds: new Set(),
  teamIds: new Set(),
  projectIds: new Set(),
  memberSpaceIds: new Set(),
  ...overrides,
})

test('searchNativePagesHybrid excludes restricted/other-agent-private chunks for an agent viewer', async () => {
  const queries: string[] = []
  const prisma = {
    $queryRaw: async (query: { sql: string }) => {
      queries.push(query.sql)
      return []
    },
    knowledgePage: { findMany: async () => [] },
  } as unknown as PrismaClient
  const agentViewer: SpaceViewer = {
    bypass: false,
    userId: null,
    projectIds: new Set(),
    visibleAgentIds: new Set(),
    agent: agentScopes(),
  }

  await searchNativePagesHybrid(prisma, {
    organizationId,
    query: 'runbook',
    queryEmbedding: null,
    viewer: agentViewer,
  })

  assert.match(queries[0] ?? '', /c\.sensitivity_tier <> 'restricted'::"SensitivityTier"/)
  assert.match(queries[0] ?? '', /c\.private_to_agent_id IS NULL OR c\.private_to_agent_id = \?::uuid/)
})

test('searchNativePagesHybrid excludes agent-private chunks entirely for a user viewer', async () => {
  const queries: string[] = []
  const prisma = {
    $queryRaw: async (query: { sql: string }) => {
      queries.push(query.sql)
      return []
    },
    knowledgePage: { findMany: async () => [] },
  } as unknown as PrismaClient
  const userViewer: SpaceViewer = {
    bypass: false,
    userId: 'user-1',
    projectIds: new Set(),
    visibleAgentIds: new Set(),
  }

  await searchNativePagesHybrid(prisma, {
    organizationId,
    query: 'runbook',
    queryEmbedding: null,
    viewer: userViewer,
  })

  assert.match(queries[0] ?? '', /AND c\.private_to_agent_id IS NULL/)
  assert.doesNotMatch(queries[0] ?? '', /sensitivity_tier <> 'restricted'/)
})

test('searchNativePagesHybrid adds no chunk-privacy predicate for a bypass viewer', async () => {
  const queries: string[] = []
  const prisma = {
    $queryRaw: async (query: { sql: string }) => {
      queries.push(query.sql)
      return []
    },
    knowledgePage: { findMany: async () => [] },
  } as unknown as PrismaClient

  await searchNativePagesHybrid(prisma, {
    organizationId,
    query: 'runbook',
    queryEmbedding: null,
    viewer: {
      bypass: true,
      userId: null,
      projectIds: new Set(),
      visibleAgentIds: new Set(),
    },
  })

  assert.doesNotMatch(queries[0] ?? '', /private_to_agent_id/)
  assert.doesNotMatch(queries[0] ?? '', /sensitivity_tier <> 'restricted'/)
})

test('searchNativePagesHybrid short-circuits on blank query without hitting the database', async () => {
  const queries: string[] = []
  const prisma = {
    $queryRaw: async (query: { sql: string }) => {
      queries.push(query.sql)
      return []
    },
  } as unknown as PrismaClient

  const result = await searchNativePagesHybrid(prisma, {
    organizationId,
    query: '   ',
    queryEmbedding: null,
  })

  assert.equal(queries.length, 0)
  assert.deepEqual(result, { data: [], meta: { cursor: null, hasMore: false } })
})
