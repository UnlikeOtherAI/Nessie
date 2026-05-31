import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type {
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

const makePage = (): KnowledgePageRecord => ({
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
})

const makeProvider = (calls: string[]): KnowledgeProvider => ({
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
  getPage: async () => null,
  getSpace: async () => null,
  listPages: async () => [],
  listSpaces: async () => ({ data: [], meta: { cursor: null, hasMore: false } }),
  listVersions: async () => [],
  movePage: async () => null,
  publishPage: async () => null,
  restoreVersion: async () => null,
  searchPages: async () => ({ data: [], meta: { cursor: null, hasMore: false } }),
  updatePage: async () => null,
  updateSpace: async () => null,
})

const makeApp = (effect: 'allow' | 'deny') => {
  const auditLogs: Array<Record<string, unknown>> = []
  const calls: string[] = []
  const prisma = {
    $queryRaw: async () => (effect === 'allow' ? [policyRow('allow')] : [policyRow('deny')]),
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditLogs.push(data)
      },
    },
  } as unknown as PrismaClient
  const app = Fastify({ logger: false })
  registerKnowledgeBaseRoutes(app, {
    prisma,
    knowledgeProvider: makeProvider(calls),
    requireActorContext: () => actorContext,
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
