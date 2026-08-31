import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { KnowledgeProvider, KnowledgeSpaceRecord } from '@nessie/knowledge'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerAgentDocumentRoutes } from '../src/routes/agent-documents.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const teamId = '00000000-0000-4000-8000-000000000003'
const userId = '00000000-0000-4000-8000-000000000004'
const agentId = '00000000-0000-4000-8000-000000000005'
const spaceId = '00000000-0000-4000-8000-000000000006'

const actorContext: AuthorizedActionContext = {
  actionContext: { requestId: 'request-agent-docs' },
  actor: { actorId: userId, actorType: 'user', roles: ['member'] },
  tenant: { organizationId, projectId, teamId },
}

const space = {
  channelId: null,
  createdAt: '2026-08-31T12:00:00.000Z',
  createdBy: agentId,
  deletedAt: null,
  description: null,
  id: spaceId,
  memberAgentIds: [],
  memberUserIds: [userId],
  metadata: { agentDocs: true },
  name: 'Researcher — Documents',
  ownerAgentId: agentId,
  organizationId,
  privateToAgentId: null,
  projectId,
  sensitivityTier: 'normal',
  teamId,
  threadId: null,
  updatedAt: '2026-08-31T12:00:00.000Z',
  userId: null,
  visibility: 'private',
  writeRestricted: true,
} as KnowledgeSpaceRecord

const makeApp = (input: { accessible: boolean; hasSpace: boolean; readable?: boolean }) => {
  let lookupCount = 0
  const prisma = {
    agent: {
      // The landed agent-audience loader resolves visible ids in one query.
      findMany: async () => input.accessible ? [{ id: agentId }] : [],
    },
    knowledgeSpace: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        lookupCount += 1
        assert.deepEqual(where, {
          deletedAt: null,
          organizationId,
          ownerAgentId: agentId,
        })
        return input.hasSpace ? { id: spaceId, name: space.name } : null
      },
    },
    projectMember: {
      findMany: async () => [{ projectId }],
    },
  } as unknown as PrismaClient
  const knowledgeProvider = {
    getSpace: async (requestedOrganizationId: string, requestedSpaceId: string) => {
      assert.equal(requestedOrganizationId, organizationId)
      assert.equal(requestedSpaceId, spaceId)
      return input.readable === false
        ? { ...space, memberUserIds: [] }
        : space
    },
  } as unknown as KnowledgeProvider
  const app = Fastify({ logger: false })
  registerAgentDocumentRoutes(app, {
    isAgentAccessibleToActor: async () => input.accessible,
    knowledgeProvider,
    prisma,
    requireActorContext: () => actorContext,
  } as unknown as Parameters<typeof registerAgentDocumentRoutes>[1])
  return { app, lookupCount: () => lookupCount }
}

test('GET agent docs returns the readable agent home reference without recomputing write access', async () => {
  const { app } = makeApp({ accessible: true, hasSpace: true })
  try {
    const response = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/docs` })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().data, {
      space: { canRead: true, id: spaceId, name: 'Researcher — Documents' },
    })
  } finally {
    await app.close()
  }
})

test('GET agent docs reports when an accessible agent home is not readable', async () => {
  const { app } = makeApp({ accessible: true, hasSpace: true, readable: false })
  try {
    const response = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/docs` })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().data, { space: { canRead: false } })
  } finally {
    await app.close()
  }
})

test('GET agent docs hides an inaccessible agent as not found', async () => {
  const { app, lookupCount } = makeApp({ accessible: false, hasSpace: true })
  try {
    const response = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/docs` })
    assert.equal(response.statusCode, 404)
    assert.equal(response.json().error.code, 'AGENT_NOT_FOUND')
    assert.equal(lookupCount(), 0)
  } finally {
    await app.close()
  }
})

test('GET agent docs returns an empty state without provisioning', async () => {
  const { app, lookupCount } = makeApp({ accessible: true, hasSpace: false })
  try {
    const response = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/docs` })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().data, { space: null })
    assert.equal(lookupCount(), 1)
  } finally {
    await app.close()
  }
})
