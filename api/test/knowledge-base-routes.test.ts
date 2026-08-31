import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  KnowledgeConflictError,
  type CreatePageInput,
  KnowledgePageRecord,
  KnowledgeProvider,
  KnowledgeSpaceRecord,
} from '@nessie/knowledge'
import { registerKnowledgeBaseRoutes } from '../src/routes/knowledge-base.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const userId = '00000000-0000-4000-8000-000000000003'
const spaceId = '00000000-0000-4000-8000-000000000004'
const pageId = '00000000-0000-4000-8000-000000000005'
const versionId = '00000000-0000-4000-8000-000000000006'

const actorContext: AuthorizedActionContext = {
  actor: { actorType: 'user', actorId: userId, roles: ['owner'] },
  tenant: { organizationId, projectId },
  actionContext: { requestId: 'req-kb-test' },
}

const policyRow = (effect: 'allow' | 'deny') => ({
  id: `00000000-0000-4000-8000-0000000000${effect === 'allow' ? '10' : '11'}`,
  scope: 'organization',
  scopeId: organizationId,
  resourceType: 'knowledge_page',
  action: 'create',
  effect,
  priority: 10,
  conditions: null,
  actorType: 'role',
  actorId: '*',
})

const makeSpace = (): KnowledgeSpaceRecord => ({
  id: spaceId,
  name: 'Engineering',
  description: null,
  metadata: null,
  ownerAgentId: null,
  organizationId,
  projectId,
  teamId: null,
  channelId: null,
  threadId: null,
  userId: null,
  visibility: 'project',
  sensitivityTier: 'normal',
  privateToAgentId: null,
  createdBy: userId,
  deletedAt: null,
  createdAt: '2026-05-31T10:00:00.000Z',
  updatedAt: '2026-05-31T10:00:00.000Z',
})

const makePage = (input: Partial<KnowledgePageRecord> = {}): KnowledgePageRecord => ({
  id: pageId,
  spaceId,
  title: 'Runbook',
  summary: null,
  metadata: null,
  parentPageId: null,
  position: 0,
  status: 'draft',
  labels: ['ops'],
  latestVersion: {
    id: versionId,
    pageId,
    versionNumber: 1,
    body: '# Runbook',
    bodyRef: null,
    authorType: 'user',
    authorId: userId,
    changeComment: null,
    createdAt: '2026-05-31T10:00:00.000Z',
  },
  publishedVersion: null,
  publishedVersionId: null,
  organizationId,
  projectId,
  teamId: null,
  channelId: null,
  threadId: null,
  userId: null,
  visibility: 'project',
  sensitivityTier: 'normal',
  privateToAgentId: null,
  createdBy: userId,
  deletedAt: null,
  createdAt: '2026-05-31T10:00:00.000Z',
  updatedAt: '2026-05-31T10:00:00.000Z',
  ...input,
})

const versionConflictError = () =>
  new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`page_id`,`version_number`)',
    {
      clientVersion: 'test',
      code: 'P2002',
      meta: { target: ['page_id', 'version_number'] },
    },
  )

const makeProvider = (
  calls: string[],
  overrides: Partial<KnowledgeProvider> = {},
): KnowledgeProvider => {
  const provider: KnowledgeProvider = {
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
      calls.push('createPage')
      return makePage()
    },
    createSpace: async () => {
      calls.push('createSpace')
      return makeSpace()
    },
    getPage: async () => makePage(),
    getSpace: async () => makeSpace(),
    listPages: async () => [],
    listRecentPages: async () => [],
    listSpaces: async () => ({ data: [], meta: { cursor: null, hasMore: false } }),
    listVersions: async () => [],
    movePage: async () => null,
    publishPage: async () => null,
    restoreVersion: async () => null,
    searchPages: async () => ({ data: [], meta: { cursor: null, hasMore: false } }),
    updatePage: async () => null,
    updateSpace: async () => null,
  }
  return { ...provider, ...overrides }
}

const makeApp = (
  effect: 'allow' | 'deny',
  providerOverrides: Partial<KnowledgeProvider> = {},
  actorContextOverride: AuthorizedActionContext = actorContext,
) => {
  const auditLogs: Array<Record<string, unknown>> = []
  const calls: string[] = []
  const prisma = {
    $queryRaw: async () => (effect === 'allow' ? [policyRow('allow')] : [policyRow('deny')]),
    // The hash-chain audit writer takes a pg advisory lock + reads the chain tip.
    $executeRaw: async () => 0,
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation(prisma),
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditLogs.push(data)
      },
      // The hash-chain audit writer reads the current chain tip first.
      findFirst: async () => null,
    },
    // The per-space access layer (loadSpaceViewer) resolves the caller's project
    // memberships; the actor is a member of the space's project.
    projectMember: {
      findMany: async () => [{ projectId }],
    },
    agent: { findMany: async () => [] },
    agentBinding: {
      findMany: async () => [],
    },
    knowledgeSpaceMember: {
      findMany: async () => [],
    },
  } as unknown as PrismaClient
  const app = Fastify({ logger: false })
  registerKnowledgeBaseRoutes(app, {
    prisma,
    knowledgeProvider: makeProvider(calls, providerOverrides),
    requireActorContext: () => actorContextOverride,
  } as unknown as Parameters<typeof registerKnowledgeBaseRoutes>[1])
  return { app, auditLogs, calls }
}

test('knowledge routes deny before provider mutation when policy denies', async () => {
  const { app, auditLogs, calls } = makeApp('deny')
  const response = await app.inject({
    method: 'POST',
    url: `/api/knowledge-base/spaces/${spaceId}/pages`,
    payload: { title: 'Runbook', body: '# Runbook', projectId },
  })

  assert.equal(response.statusCode, 403)
  assert.deepEqual(calls, [])
  assert.deepEqual(auditLogs, [])
  await app.close()
})

test('knowledge page creation emits audit and provenance envelope', async () => {
  const { app, auditLogs, calls } = makeApp('allow')
  const response = await app.inject({
    method: 'POST',
    url: `/api/knowledge-base/spaces/${spaceId}/pages`,
    payload: { title: 'Runbook', body: '# Runbook', labels: ['ops'], projectId },
  })

  assert.equal(response.statusCode, 201)
  assert.deepEqual(calls, ['createPage'])
  assert.equal(auditLogs.length, 1)
  assert.equal(auditLogs[0]?.['action'], 'kb.page.created')
  assert.equal(auditLogs[0]?.['resourceType'], 'knowledge_page')

  const payload = response.json() as { data: Record<string, unknown> }
  assert.equal(payload.data['sourceRef'], `kb://first-party/pages/${pageId}/versions/${versionId}`)
  assert.deepEqual(payload.data['policyChainTrace'], [
    'decision:ALLOWED',
    'source:organization:00000000-0000-4000-8000-000000000001/allow',
    'rule:00000000-0000-4000-8000-000000000010',
  ])
  await app.close()
})

test('knowledge routes derive page authorType from actor context, not request body', async () => {
  const authorTypes: CreatePageInput['authorType'][] = []
  const { app } = makeApp('allow', {
    createPage: async (input) => {
      authorTypes.push(input.authorType)
      return makePage({
        latestVersion: makePage().latestVersion
          ? { ...makePage().latestVersion, authorType: input.authorType }
          : null,
      })
    },
  })
  const response = await app.inject({
    method: 'POST',
    url: `/api/knowledge-base/spaces/${spaceId}/pages`,
    payload: {
      title: 'Runbook',
      body: '# Runbook',
      authorType: 'agent',
      projectId,
    },
  })

  assert.equal(response.statusCode, 201)
  assert.deepEqual(authorTypes, ['user'])
  await app.close()
})

test('knowledge page listing verifies the space before listing pages', async () => {
  const { app, calls } = makeApp('allow', {
    getSpace: async () => null,
    listPages: async () => {
      calls.push('listPages')
      return []
    },
  })
  const response = await app.inject({
    method: 'GET',
    url: `/api/knowledge-base/spaces/${spaceId}/pages`,
  })

  assert.equal(response.statusCode, 404)
  assert.deepEqual(calls, [])
  await app.close()
})

test('knowledge publish maps archived page conflicts to a clean 409', async () => {
  const { app } = makeApp('allow', {
    publishPage: async () => {
      throw new KnowledgeConflictError('Archived pages are read-only')
    },
  })
  const response = await app.inject({
    method: 'POST',
    url: `/api/knowledge-base/pages/${pageId}/publish`,
  })
  const payload = response.json() as { error: { code: string; message: string } }

  assert.equal(response.statusCode, 409)
  assert.equal(payload.error.code, 'KNOWLEDGE_MUTATION_CONFLICT')
  assert.equal(payload.error.message, 'Archived pages are read-only')
  await app.close()
})

test('knowledge publish rejects an agent actor before touching policy or the provider', async () => {
  const agentActorContext: AuthorizedActionContext = {
    actor: { actorType: 'agent', actorId: '00000000-0000-4000-8000-000000000099', roles: [] },
    tenant: { organizationId, projectId },
    actionContext: { requestId: 'req-kb-agent-publish' },
  }
  const { app, calls } = makeApp('allow', {
    publishPage: async () => {
      calls.push('publishPage')
      return makePage({ status: 'published' })
    },
  }, agentActorContext)
  const response = await app.inject({
    method: 'POST',
    url: `/api/knowledge-base/pages/${pageId}/publish`,
  })
  const payload = response.json() as { error: { code: string } }

  assert.equal(response.statusCode, 403)
  assert.equal(payload.error.code, 'POLICY_DENIED')
  assert.deepEqual(calls, [])
  await app.close()
})

test('knowledge search falls back to keyword mode when there is no query text', async () => {
  const searchCalls: string[] = []
  const { app } = makeApp('allow', {
    searchPages: async () => {
      searchCalls.push('searchPages')
      return { data: [], meta: { cursor: null, hasMore: false } }
    },
    searchPagesHybrid: async () => {
      searchCalls.push('searchPagesHybrid')
      return { data: [], meta: { cursor: null, hasMore: false } }
    },
  })
  const response = await app.inject({
    method: 'POST',
    url: '/api/knowledge-base/search',
    payload: {},
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(searchCalls, ['searchPages'])
  await app.close()
})

test('knowledge search uses hybrid mode by default when a query is present', async () => {
  const searchCalls: string[] = []
  const { app } = makeApp('allow', {
    searchPages: async () => {
      searchCalls.push('searchPages')
      return { data: [], meta: { cursor: null, hasMore: false } }
    },
    searchPagesHybrid: async (input) => {
      searchCalls.push('searchPagesHybrid')
      assert.equal(input.query, 'runbook')
      assert.equal(input.queryEmbedding, null)
      return { data: [], meta: { cursor: null, hasMore: false } }
    },
  })
  const response = await app.inject({
    method: 'POST',
    url: '/api/knowledge-base/search',
    payload: { query: 'runbook' },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(searchCalls, ['searchPagesHybrid'])
  await app.close()
})

test('knowledge search honors an explicit keyword mode even with a query present', async () => {
  const searchCalls: string[] = []
  const { app } = makeApp('allow', {
    searchPages: async () => {
      searchCalls.push('searchPages')
      return { data: [], meta: { cursor: null, hasMore: false } }
    },
    searchPagesHybrid: async () => {
      searchCalls.push('searchPagesHybrid')
      return { data: [], meta: { cursor: null, hasMore: false } }
    },
  })
  const response = await app.inject({
    method: 'POST',
    url: '/api/knowledge-base/search',
    payload: { query: 'runbook', mode: 'keyword' },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(searchCalls, ['searchPages'])
  await app.close()
})

test('knowledge mutations map Prisma unique conflicts without leaking constraint text', async () => {
  const { app } = makeApp('allow', {
    updatePage: async () => {
      throw versionConflictError()
    },
  })
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/knowledge-base/pages/${pageId}`,
    payload: { body: '# Updated' },
  })
  const payload = response.json() as { error: { code: string; message: string } }

  assert.equal(response.statusCode, 409)
  assert.equal(payload.error.code, 'KNOWLEDGE_MUTATION_CONFLICT')
  assert.equal(payload.error.message, 'Knowledge base mutation conflict')
  assert.equal(payload.error.message.includes('page_id'), false)
  await app.close()
})

// The session's `proj` claim is only the caller's oldest project membership, so
// scoping the space list to it hid org-visibility spaces filed in a sibling
// project and the caller's own "My Docs" when it lived under another project —
// and an empty list makes the admin seed a duplicate "General". What the caller
// may see is canReadSpace's decision inside listSpaces, not their session.
test('knowledge space listing is organization-wide unless a project is requested', async () => {
  const seen: Array<string | undefined> = []
  const { app } = makeApp('allow', {
    listSpaces: async (input) => {
      seen.push(input.projectId)
      return { data: [], meta: { cursor: null, hasMore: false } }
    },
  })

  const orgWide = await app.inject({ method: 'GET', url: '/api/knowledge-base/spaces' })
  assert.equal(orgWide.statusCode, 200)

  const otherProjectId = '00000000-0000-4000-8000-0000000000a1'
  const narrowed = await app.inject({
    method: 'GET',
    url: `/api/knowledge-base/spaces?projectId=${otherProjectId}`,
  })
  assert.equal(narrowed.statusCode, 200)

  assert.deepEqual(seen, [undefined, otherProjectId])
  await app.close()
})

test('knowledge search is organization-wide unless a project is requested', async () => {
  const seen: Array<string | undefined> = []
  const { app } = makeApp('allow', {
    searchPagesHybrid: async (input) => {
      seen.push(input.projectId)
      return { data: [], meta: { cursor: null, hasMore: false } }
    },
  })

  const orgWide = await app.inject({
    method: 'POST',
    url: '/api/knowledge-base/search',
    payload: { query: 'runbook' },
  })
  assert.equal(orgWide.statusCode, 200)

  const otherProjectId = '00000000-0000-4000-8000-0000000000a2'
  const narrowed = await app.inject({
    method: 'POST',
    url: '/api/knowledge-base/search',
    payload: { query: 'runbook', projectId: otherProjectId },
  })
  assert.equal(narrowed.statusCode, 200)

  assert.deepEqual(seen, [undefined, otherProjectId])
  await app.close()
})
