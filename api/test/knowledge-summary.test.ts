import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { KnowledgeProvider, KnowledgeSearchHit } from '@nessie/knowledge'
import type { LedgerAttribution, ModelClient, ModelMessage } from '@nessie/runtime'
import {
  buildSummaryPassages,
  MAX_SUMMARY_CHARS,
  MAX_SUMMARY_CHUNKS,
  synthesizeSummary,
  validateModelOutput,
} from '../src/services/knowledge-summary.js'
import { registerKnowledgeSummaryRoutes } from '../src/routes/knowledge-summary.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const userId = '00000000-0000-4000-8000-000000000003'
const spaceId = '00000000-0000-4000-8000-000000000004'

const actorContext: AuthorizedActionContext = {
  actor: { actorType: 'user', actorId: userId, roles: ['owner'] },
  tenant: { organizationId, projectId },
  actionContext: { requestId: 'req-kb-summary-test' },
}

const usage: LedgerAttribution = { organizationId, actorId: userId }

const policyRow = (effect: 'allow' | 'deny') => ({
  id: `00000000-0000-4000-8000-0000000000${effect === 'allow' ? '10' : '11'}`,
  scope: 'organization',
  scopeId: organizationId,
  resourceType: 'knowledge_page',
  action: 'search',
  effect,
  priority: 10,
  conditions: null,
  actorType: 'role',
  actorId: '*',
})

// Only the fields buildSummaryPassages / the route handler actually read are
// populated; KnowledgeSearchHit's full KnowledgePageRecord shape is not
// relevant to this module's logic.
const makeHit = (
  pageId: string,
  title: string,
  overrides: Partial<KnowledgeSearchHit> = {},
): KnowledgeSearchHit =>
  ({
    page: { id: pageId, title, spaceId },
    snippet: `${title} snippet`,
    ...overrides,
  }) as unknown as KnowledgeSearchHit

const fakeModelClient = (chatJson: ModelClient['chatJson']): ModelClient =>
  ({ chatJson, embed: async () => [0.1, 0.2, 0.3] }) as unknown as ModelClient

// ─── buildSummaryPassages ───────────────────────────────────────────────────

test('buildSummaryPassages caps at MAX_SUMMARY_CHUNKS chunks across hits', () => {
  const hits = Array.from({ length: 12 }, (_, i) =>
    makeHit(`page-${i}`, `Page ${i}`, {
      passages: [{ content: `chunk ${i}`, startOffset: 0, endOffset: 10, score: 1 }],
    }))

  const passages = buildSummaryPassages(hits)

  assert.equal(passages.length, MAX_SUMMARY_CHUNKS)
  assert.deepEqual(passages.map((p) => p.pageId), hits.slice(0, MAX_SUMMARY_CHUNKS).map((h) => h.page.id))
})

test('buildSummaryPassages trims whole passages once the char budget is exceeded, never mid-passage', () => {
  // Each passage is 2500 chars; three of them would total 7500, over the
  // MAX_SUMMARY_CHARS (6000) budget, so only the first two should be kept —
  // and kept whole, not truncated.
  const bigContent = 'x'.repeat(2500)
  const hits = [
    makeHit('page-0', 'Page 0', { passages: [{ content: bigContent, startOffset: 0, endOffset: 2500, score: 1 }] }),
    makeHit('page-1', 'Page 1', { passages: [{ content: bigContent, startOffset: 0, endOffset: 2500, score: 1 }] }),
    makeHit('page-2', 'Page 2', { passages: [{ content: bigContent, startOffset: 0, endOffset: 2500, score: 1 }] }),
  ]

  const passages = buildSummaryPassages(hits)

  assert.equal(passages.length, 2)
  assert.equal(passages[0]?.content.length, 2500)
  assert.equal(passages[1]?.content.length, 2500)
  assert.ok(passages.every((p) => p.content === bigContent))
  const totalChars = passages.reduce((sum, p) => sum + p.content.length, 0)
  assert.ok(totalChars <= MAX_SUMMARY_CHARS)
})

test('buildSummaryPassages falls back to the snippet when a hit has no passages', () => {
  const hits = [makeHit('page-0', 'Page 0')]
  const passages = buildSummaryPassages(hits)
  assert.equal(passages.length, 1)
  assert.equal(passages[0]?.content, 'Page 0 snippet')
})

// ─── validateModelOutput ─────────────────────────────────────────────────────

test('validateModelOutput drops citations whose pageId is not among the supplied passages', () => {
  const allowed = new Set(['page-1'])
  const result = validateModelOutput(
    {
      answer: 'Only page-1 answers this.',
      citations: [
        { pageId: 'page-1', quote: 'a real quote' },
        { pageId: 'page-unknown', quote: 'a hallucinated quote' },
      ],
    },
    allowed,
  )

  assert.ok(result)
  assert.equal(result?.answer, 'Only page-1 answers this.')
  assert.deepEqual(result?.citations, [{ pageId: 'page-1', quote: 'a real quote' }])
})

test('validateModelOutput returns null for a shape that does not match the required contract', () => {
  const allowed = new Set(['page-1'])
  assert.equal(validateModelOutput({ foo: 'bar' }, allowed), null)
  assert.equal(validateModelOutput({ citations: [] }, allowed), null)
  assert.equal(validateModelOutput('not even an object', allowed), null)
})

// ─── synthesizeSummary (retry-once path) ────────────────────────────────────

test('synthesizeSummary retries once with a terse addendum after unparseable JSON, then succeeds', async () => {
  const messagesSeen: ModelMessage[][] = []
  let calls = 0
  const modelClient = fakeModelClient(async (messages) => {
    messagesSeen.push(messages)
    calls += 1
    if (calls === 1) {
      throw new SyntaxError('Unexpected token in JSON')
    }
    return { answer: 'Recovered answer', citations: [{ pageId: 'page-1', quote: 'quoted text' }] }
  })

  const result = await synthesizeSummary({
    modelClient,
    query: 'What is the runbook?',
    passages: [{ pageId: 'page-1', title: 'Runbook', spaceId, content: 'runbook contents' }],
    usage,
  })

  assert.equal(calls, 2)
  assert.ok(result)
  assert.equal(result?.answer, 'Recovered answer')
  assert.deepEqual(result?.citations, [{ pageId: 'page-1', quote: 'quoted text' }])
  // The retry attempt appends a terse "return only valid JSON" instruction.
  assert.equal(messagesSeen[1]?.length, (messagesSeen[0]?.length ?? 0) + 1)
})

test('synthesizeSummary returns null when both attempts fail', async () => {
  let calls = 0
  const modelClient = fakeModelClient(async () => {
    calls += 1
    throw new SyntaxError('still not JSON')
  })

  const result = await synthesizeSummary({
    modelClient,
    query: 'What is the runbook?',
    passages: [{ pageId: 'page-1', title: 'Runbook', spaceId, content: 'runbook contents' }],
    usage,
  })

  assert.equal(calls, 2)
  assert.equal(result, null)
})

// ─── route: POST /api/knowledge-base/search-summary ─────────────────────────

const makeProvider = (overrides: Partial<KnowledgeProvider> = {}): KnowledgeProvider =>
  ({
    id: 'test',
    kind: 'first_party',
    capabilities: {
      canWrite: true,
      canIncrementalSync: false,
      supportsNativeSearch: true,
      supportsServerSideACL: true,
      supportsVersionHistory: true,
      supportsHierarchicalPages: true,
      supportsDeterministicSearch: true,
    },
    archivePage: async () => null,
    archiveSpace: async () => null,
    createPage: async () => {
      throw new Error('not used by search-summary')
    },
    createSpace: async () => {
      throw new Error('not used by search-summary')
    },
    getPage: async () => null,
    getSpace: async () => null,
    listPages: async () => [],
    listRecentPages: async () => [],
    listSpaces: async () => ({ data: [], meta: { cursor: null, hasMore: false } }),
    listVersions: async () => [],
    movePage: async () => null,
    publishPage: async () => null,
    restoreVersion: async () => null,
    searchPages: async () => ({ data: [], meta: { cursor: null, hasMore: false } }),
    searchPagesHybrid: async () => ({ data: [], meta: { cursor: null, hasMore: false } }),
    updatePage: async () => null,
    updateSpace: async () => null,
    ...overrides,
  }) as KnowledgeProvider

const makeApp = (
  providerOverrides: Partial<KnowledgeProvider> = {},
  sharedModelClient: ModelClient | null = fakeModelClient(async () => ({ answer: 'unused', citations: [] })),
) => {
  const prisma = {
    $queryRaw: async () => [policyRow('allow')],
    auditLog: { create: async () => {} },
    projectMember: { findMany: async () => [{ projectId }] },
    agentBinding: { findMany: async () => [] },
    knowledgeSpaceMember: { findMany: async () => [] },
  } as unknown as PrismaClient
  const app = Fastify({ logger: false })
  registerKnowledgeSummaryRoutes(app, {
    prisma,
    knowledgeProvider: makeProvider(providerOverrides),
    requireActorContext: () => actorContext,
    sharedModelClient,
  } as unknown as Parameters<typeof registerKnowledgeSummaryRoutes>[1])
  return { app }
}

test('search-summary short-circuits on no hits without calling the model', async () => {
  let modelCalls = 0
  const modelClient = fakeModelClient(async () => {
    modelCalls += 1
    return { answer: 'should not happen', citations: [] }
  })
  const { app } = makeApp(
    { searchPagesHybrid: async () => ({ data: [], meta: { cursor: null, hasMore: false } }) },
    modelClient,
  )

  const response = await app.inject({
    method: 'POST',
    url: '/api/knowledge-base/search-summary',
    payload: { query: 'anything' },
  })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as { data: Record<string, unknown> }
  assert.deepEqual(payload.data, {
    answer: null,
    citations: [],
    sources: [],
    reason: 'no_matches',
    policyChainTrace: payload.data['policyChainTrace'],
  })
  assert.equal(modelCalls, 0)
  await app.close()
})

test('search-summary returns 503 MODEL_UNAVAILABLE when there is no shared model client', async () => {
  const { app } = makeApp({}, null)

  const response = await app.inject({
    method: 'POST',
    url: '/api/knowledge-base/search-summary',
    payload: { query: 'anything' },
  })

  assert.equal(response.statusCode, 503)
  const payload = response.json() as { error: { code: string } }
  assert.equal(payload.error.code, 'MODEL_UNAVAILABLE')
  await app.close()
})
