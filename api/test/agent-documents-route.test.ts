import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
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
const identityPageId = '00000000-0000-4000-8000-000000000008'
const stylePageId = '00000000-0000-4000-8000-000000000009'
const identityVersionId = '00000000-0000-4000-8000-000000000010'
const styleVersionId = '00000000-0000-4000-8000-000000000011'
const emptyHash = createHash('sha256').update('').digest('hex')

const privateVisibleAgentWhere = (viewerId: string) => ({
  organizationId,
  systemManaged: false,
  // A soft-deleted agent is invisible to everybody, including its owner: the
  // row survives for audit history and nothing else.
  deletedAt: null,
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

// An agent with no legacy instructions: opening its documents prepares the
// home and records the (empty) core migration, so a readable home reports an
// active core with no estimated tokens.
const readableHome = {
  core: { estimatedTokens: 0, state: 'active' },
  coreDocuments: [
    {
      filename: 'AGENTS.md',
      markdown: '',
      pageId: identityPageId,
      role: 'identity',
      versionId: identityVersionId,
      versionNumber: 1,
    },
    {
      filename: 'personality.md',
      markdown: '',
      pageId: stylePageId,
      role: 'working_rules',
      versionId: styleVersionId,
      versionNumber: 1,
    },
  ],
  space: { canRead: true, id: spaceId, name: 'Researcher — Documents' },
}

const coreRow = (
  role: 'identity' | 'working_rules',
  pageId: string,
  versionId: string,
) => ({
  page: {
    deletedAt: null,
    documentRole: role,
    id: pageId,
    kind: 'file',
    parentPageId: null,
    projectId,
    publishedVersion: {
      attachmentId: `attachment-${role}`,
      basisScopes: [],
      disclosureSources: [],
      id: versionId,
      sourceContentHash: emptyHash,
      versionNumber: 1,
    },
    sensitivityTier: 'normal',
    space: {
      deletedAt: null,
      id: spaceId,
      organizationId,
      ownerAgentId: agentId,
      projectId,
      sensitivityTier: 'normal',
      visibility: 'private',
    },
    title: role === 'identity' ? 'AGENTS.md' : 'personality.md',
    visibility: 'private',
  },
  role,
})

const makeApp = (input: {
  accessible: boolean
  actorId?: string
  agentProjectId?: string | null
  expectedVisibleAgentWhere?: unknown
  hasSpace: boolean
  readable?: boolean
  systemManaged?: boolean
  visibleAgent?: boolean
}) => {
  let lookupCount = 0
  let createCount = 0
  let homeExists = input.hasSpace
  const prisma = {
    $executeRaw: async () => 0,
    $transaction: async <T>(action: (tx: unknown) => Promise<T>) => action(prisma),
    agent: {
      findFirst: async () => ({
        id: agentId,
        name: 'Researcher',
        projectId: input.agentProjectId === undefined ? projectId : input.agentProjectId,
        speakingStyle: input.systemManaged ? 'Measured and helpful.' : null,
        systemManaged: input.systemManaged ?? false,
        systemPrompt: input.systemManaged ? 'Help people find the right knowledge.' : null,
      }),
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
    agentBinding: { findMany: async () => [] },
    agentCoreDocument: {
      findMany: async () => [
        coreRow('identity', identityPageId, identityVersionId),
        coreRow('working_rules', stylePageId, styleVersionId),
      ],
    },
    agentCoreDocumentMigration: {
      findUnique: async () => ({ documentCount: 2, id: 'migration-1' }),
    },
    channelMember: { findMany: async () => [] },
    knowledgeSpace: {
      create: async () => {
        createCount += 1
        homeExists = true
        return { id: spaceId }
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        lookupCount += 1
        assert.deepEqual(where, {
          deletedAt: null,
          organizationId,
          ownerAgentId: agentId,
        })
        return homeExists ? { id: spaceId } : null
      },
      findUnique: async () => (homeExists ? { id: spaceId, name: space.name } : null),
    },
    knowledgeSpaceMember: { findMany: async () => [] },
    // The viewer resolves the person's live local membership first.
    organization: { findUnique: async () => ({ externalOrgId: null }) },
    organizationMember: { findFirst: async () => ({ id: 'member-1', role: 'member' }) },
    project: { findFirst: async () => ({ id: projectId }) },
    projectMember: {
      findMany: async () => [{ projectId }],
    },
    teamMember: { findMany: async () => [] },
  } as unknown as PrismaClient
  const knowledgeProvider = {
    getSpace: async (requestedOrganizationId: string, requestedSpaceId: string) => {
      assert.equal(requestedOrganizationId, organizationId)
      assert.equal(requestedSpaceId, spaceId)
      return input.readable === false
        ? { ...space, memberUserIds: [] }
        : space
    },
    migrateAgentCoreDocuments: async () => ({ kind: 'migrated' as const, pageIds: [] }),
    updateAgentCoreDocuments: async () => ({ kind: 'updated' as const, pageIds: [] }),
  } as unknown as KnowledgeProvider
  const app = Fastify({ logger: false })
  registerAgentDocumentRoutes(app, {
    fileService: {
      openStream: async () => ({ stream: Readable.from(['']) }),
    },
    isAgentAccessibleToActor: async () => input.accessible,
    knowledgeProvider,
    prisma,
    requireActorContext: () => ({
      ...actorContext,
      actor: { ...actorContext.actor, actorId: input.actorId ?? userId },
    }),
  } as unknown as Parameters<typeof registerAgentDocumentRoutes>[1])
  return { app, createCount: () => createCount, lookupCount: () => lookupCount }
}

test('GET agent docs returns the readable agent home reference without recomputing write access', async () => {
  const { app } = makeApp({ accessible: true, hasSpace: true })
  try {
    const response = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/docs` })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().data, readableHome)
  } finally {
    await app.close()
  }
})

test('GET system agent docs returns the immutable two-file projection without a home', async () => {
  const { app, createCount, lookupCount } = makeApp({
    accessible: true,
    hasSpace: false,
    systemManaged: true,
  })
  try {
    const response = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/docs` })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().data, {
      projectedCoreDocuments: [
        {
          filename: 'AGENTS.md',
          markdown: 'Help people find the right knowledge.',
          role: 'identity',
        },
        {
          filename: 'personality.md',
          markdown: 'Measured and helpful.',
          role: 'working_rules',
        },
      ],
      space: null,
    })
    assert.equal(createCount(), 0)
    assert.equal(lookupCount(), 0)
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
    assert.deepEqual(response.json().data, readableHome)
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
    assert.deepEqual(ownerResponse.json().data, readableHome)
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

test('GET agent docs provisions required files for a legacy agent with no project field', async () => {
  const { app, createCount } = makeApp({
    accessible: true,
    agentProjectId: null,
    hasSpace: false,
  })
  try {
    const response = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/docs` })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().data, readableHome)
    assert.equal(createCount(), 1)
  } finally {
    await app.close()
  }
})

test('GET agent docs provisions a missing agent home once when the tab is opened', async () => {
  const { app, createCount } = makeApp({ accessible: true, hasSpace: false })
  try {
    const response = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/docs` })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().data, readableHome)
    assert.equal(createCount(), 1)
  } finally {
    await app.close()
  }
})
