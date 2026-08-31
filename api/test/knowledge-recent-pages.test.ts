import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  canReadSpace,
  type KnowledgeRecentPageRecord,
  type KnowledgeSpaceRecord,
  type ListRecentPagesInput,
} from '@nessie/knowledge'
import { registerKnowledgeRecentPagesRoutes } from '../src/routes/knowledge-recent-pages.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const userId = '00000000-0000-4000-8000-000000000003'
const otherUserId = '00000000-0000-4000-8000-000000000004'
const openSpaceId = '00000000-0000-4000-8000-000000000005'
const privateSpaceId = '00000000-0000-4000-8000-000000000006'
const openPageId = '00000000-0000-4000-8000-000000000007'
const privatePageId = '00000000-0000-4000-8000-000000000008'
const foreignProjectId = '00000000-0000-4000-8000-000000000009'

const actorContext: AuthorizedActionContext = {
  actor: { actorType: 'user', actorId: userId, roles: ['member'] },
  tenant: { organizationId, projectId },
  actionContext: { requestId: 'req-kb-recent' },
}

const policyRow = {
  id: '00000000-0000-4000-8000-000000000010',
  scope: 'organization',
  scopeId: organizationId,
  resourceType: 'knowledge_page',
  action: 'view',
  effect: 'allow',
  priority: 10,
  conditions: null,
  actorType: 'role',
  actorId: '*',
}

const makeSpace = (overrides: Partial<KnowledgeSpaceRecord>): KnowledgeSpaceRecord => ({
  id: openSpaceId,
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
  writeRestricted: false,
  memberUserIds: [],
  memberAgentIds: [],
  sensitivityTier: 'normal',
  privateToAgentId: null,
  createdBy: otherUserId,
  deletedAt: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
  ...overrides,
})

// The caller belongs to the project, so the project-visible space is readable
// and the private space (created by someone else, no explicit membership) is
// not — decided by the shipped `canReadSpace`, not by a rule restated here.
const openSpace = makeSpace({})
const privateSpace = makeSpace({
  id: privateSpaceId,
  name: 'Leadership',
  visibility: 'private',
})

const pagesBySpace: Record<string, KnowledgeRecentPageRecord> = {
  [openSpaceId]: {
    id: openPageId,
    spaceId: openSpaceId,
    spaceName: openSpace.name,
    title: 'Launch plan',
    kind: 'document',
    status: 'published',
    updatedAt: '2026-08-10T09:00:00.000Z',
  },
  [privateSpaceId]: {
    id: privatePageId,
    spaceId: privateSpaceId,
    spaceName: privateSpace.name,
    title: 'Comp review',
    kind: 'document',
    status: 'draft',
    updatedAt: '2026-08-11T09:00:00.000Z',
  },
}

type ProviderCall = ListRecentPagesInput

const makeApp = (options: {
  projectAccessible?: boolean
  projectMemberships?: string[]
} = {}) => {
  const calls: ProviderCall[] = []
  const prisma = {
    $queryRaw: async () => [policyRow],
    projectMember: {
      findMany: async () =>
        (options.projectMemberships ?? [projectId]).map((id) => ({ projectId: id })),
    },
    agent: { findMany: async () => [] },
    agentBinding: { findMany: async () => [] },
    knowledgeSpaceMember: { findMany: async () => [] },
  } as unknown as PrismaClient

  // A provider that resolves the same access question the SQL pre-filter
  // encodes, so the route test proves the viewer actually reaches it.
  const knowledgeProvider = {
    listRecentPages: async (input: ListRecentPagesInput) => {
      calls.push(input)
      const readable = [openSpace, privateSpace].filter((space) =>
        input.viewer && !input.viewer.bypass ? canReadSpace(space, input.viewer) : true,
      )
      return readable.map((space) => pagesBySpace[space.id]!)
    },
  }

  const app = Fastify({ logger: false })
  registerKnowledgeRecentPagesRoutes(app, {
    prisma,
    knowledgeProvider,
    requireActorContext: () => actorContext,
    isProjectAccessibleToActor: async () => options.projectAccessible ?? true,
  } as unknown as Parameters<typeof registerKnowledgeRecentPagesRoutes>[1])
  return { app, calls }
}

test('recent pages never leak a space the caller cannot read', async () => {
  const { app } = makeApp()
  const response = await app.inject({
    method: 'GET',
    url: `/api/knowledge-base/recent-pages?projectId=${projectId}`,
  })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as { data: KnowledgeRecentPageRecord[] }
  assert.deepEqual(
    payload.data.map((row) => row.id),
    [openPageId],
  )
  await app.close()
})

test('recent pages hide even the project-visible space from a non-member', async () => {
  const { app } = makeApp({ projectMemberships: [] })
  const response = await app.inject({
    method: 'GET',
    url: `/api/knowledge-base/recent-pages?projectId=${projectId}`,
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual((response.json() as { data: unknown[] }).data, [])
  await app.close()
})

test('recent pages forward the authenticated org, the asked project, and the limit', async () => {
  const { app, calls } = makeApp()
  const response = await app.inject({
    method: 'GET',
    url: `/api/knowledge-base/recent-pages?projectId=${projectId}&limit=100&organizationId=${foreignProjectId}`,
  })

  assert.equal(response.statusCode, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.organizationId, organizationId)
  assert.equal(calls[0]?.projectId, projectId)
  // Forwarded verbatim; the provider clamps it to 20 (package test).
  assert.equal(calls[0]?.limit, 100)
  assert.equal(calls[0]?.viewer?.bypass, false)
  await app.close()
})

test('recent pages 404 an inaccessible project instead of returning an empty list', async () => {
  const { app, calls } = makeApp({ projectAccessible: false })
  const response = await app.inject({
    method: 'GET',
    url: `/api/knowledge-base/recent-pages?projectId=${foreignProjectId}`,
  })

  assert.equal(response.statusCode, 404)
  assert.equal((response.json() as { error: { code: string } }).error.code, 'PROJECT_NOT_FOUND')
  assert.deepEqual(calls, [])
  await app.close()
})

test('recent pages require a projectId', async () => {
  const { app, calls } = makeApp()
  const response = await app.inject({
    method: 'GET',
    url: '/api/knowledge-base/recent-pages',
  })

  assert.equal(response.statusCode, 400)
  assert.deepEqual(calls, [])
  await app.close()
})
