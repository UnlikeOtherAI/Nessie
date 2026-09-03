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
const sharedChannelUserId = '00000000-0000-4000-8000-000000000007'
const agentId = '00000000-0000-4000-8000-000000000005'
const spaceId = '00000000-0000-4000-8000-000000000006'

const privateVisibleAgentWhere = (viewerId: string) => ({
  organizationId,
  systemManaged: false,
  AND: [
    {
      OR: [
        {
          bindings: {
            some: {
              channel: {
                organizationId,
                OR: [
                  { visibility: 'public' },
                  { members: { some: { userId: viewerId } } },
                ],
              },
            },
          },
        },
        {
          ownerMembership: { deactivatedAt: null },
          ownerUserId: viewerId,
          parentAgentId: null,
        },
      ],
    },
    {
      OR: [
        { visibility: 'team' },
        {
          visibility: 'private',
          ownerMembership: { deactivatedAt: null },
          ownerUserId: viewerId,
          parentAgentId: null,
        },
      ],
    },
  ],
})

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
  memberUserIds: [],
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

const makeApp = (input: {
  accessible: boolean
  actorId?: string
  expectedVisibleAgentWhere?: unknown
  hasSpace: boolean
  readable?: boolean
  visibleAgent?: boolean
}) => {
  let lookupCount = 0
  const prisma = {
    agent: {
      // Route accessibility and the live audience of an agent-owned space are
      // deliberately separate: an owner can reach an unbound agent's detail
      // surface without that agent's documents becoming readable.
      findMany: async ({ where }: { where: unknown }) => {
        if (input.expectedVisibleAgentWhere) {
          assert.deepEqual(where, input.expectedVisibleAgentWhere)
        }
        return (input.visibleAgent ?? input.readable !== false) ? [{ id: agentId }] : []
      },
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
    requireActorContext: () => ({
      ...actorContext,
      actor: { ...actorContext.actor, actorId: input.actorId ?? userId },
    }),
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

test('GET agent docs admits the live agent audience without a direct space membership', async () => {
  const { app } = makeApp({
    accessible: true,
    hasSpace: true,
    readable: false,
    visibleAgent: true,
  })
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

test('GET agent docs applies the private-agent audience fence before returning a home', async () => {
  const owner = makeApp({
    accessible: true,
    actorId: userId,
    expectedVisibleAgentWhere: privateVisibleAgentWhere(userId),
    hasSpace: true,
    visibleAgent: true,
  })
  const sharedChannelReader = makeApp({
    accessible: true,
    actorId: sharedChannelUserId,
    expectedVisibleAgentWhere: privateVisibleAgentWhere(sharedChannelUserId),
    hasSpace: true,
    visibleAgent: false,
  })
  try {
    const [ownerResponse, readerResponse] = await Promise.all([
      owner.app.inject({ method: 'GET', url: `/api/agents/${agentId}/docs` }),
      sharedChannelReader.app.inject({ method: 'GET', url: `/api/agents/${agentId}/docs` }),
    ])
    assert.deepEqual(ownerResponse.json().data, {
      space: { canRead: true, id: spaceId, name: 'Researcher — Documents' },
    })
    assert.deepEqual(readerResponse.json().data, { space: { canRead: false } })
  } finally {
    await owner.app.close()
    await sharedChannelReader.app.close()
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
