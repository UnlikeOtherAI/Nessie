import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerThreadRoutes } from '../src/routes/threads.js'

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001'
const INSIDER_ID = '00000000-0000-4000-8000-000000000002'
const OUTSIDER_ID = '00000000-0000-4000-8000-000000000003'
const CHANNEL_ID = '00000000-0000-4000-8000-000000000004'
const THREAD_ID = '00000000-0000-4000-8000-000000000005'
const AGENT_ID = '00000000-0000-4000-8000-000000000006'
const RUN_ID = '00000000-0000-4000-8000-000000000007'
const SESSION_ID = '00000000-0000-4000-8000-000000000008'
const MISSING_SESSION_ID = '00000000-0000-4000-8000-000000000009'
const SPACE_ID = '00000000-0000-4000-8000-000000000010'
const MARKDOWN = '# Confidential launch\n\nThe code name is **Nessie**.\n'

const sessionRow = {
  agentId: AGENT_ID,
  chars: MARKDOWN.length,
  createdAt: new Date('2026-08-31T09:00:00.000Z'),
  errorReason: null,
  id: SESSION_ID,
  organizationId: ORGANIZATION_ID,
  overrideParentPageId: null,
  overrideSpaceId: null,
  pageId: null,
  parentPageId: null,
  published: false,
  runId: RUN_ID,
  spaceId: SPACE_ID,
  status: 'streaming',
  threadId: THREAD_ID,
  title: 'Confidential launch',
  versionNumber: null,
} as const

const actorContextFor = (userId: string): AuthorizedActionContext => ({
  actionContext: { requestId: `request-${userId}` },
  actor: { actorId: userId, actorType: 'user', roles: ['member'] },
  tenant: { organizationId: ORGANIZATION_ID },
} as unknown as AuthorizedActionContext)

const makeApp = (viewerUserId: string) => {
  let chunkReads = 0
  let publishedTargets = 0
  let retargetWrites = 0
  let targetSpaceReads = 0
  let targetNameReads = 0
  const prisma = {
    channelMember: { findMany: async () => [] },
    disclosureGrant: { findMany: async () => [] },
    knowledgePage: {
      findMany: async () => {
        targetNameReads += 1
        return []
      },
    },
    knowledgeSpace: {
      findMany: async () => {
        targetNameReads += 1
        return [{ id: SPACE_ID, name: 'Private strategy' }]
      },
    },
    organizationMember: { findFirst: async () => ({ id: `membership-${viewerUserId}` }) },
    projectMember: { findMany: async () => [] },
    run: {
      findUnique: async () => ({ agentId: AGENT_ID, thread: { channelId: CHANNEL_ID } }),
    },
    runBasisScope: {
      // Only the insider satisfies the run's user-private source scope.
      findMany: async () => [{ scopeId: INSIDER_ID, scopeType: 'user' }],
    },
    runDocumentChunk: {
      findMany: async () => {
        chunkReads += 1
        return [{ content: MARKDOWN }]
      },
    },
    runDocumentSession: {
      findFirst: async (args: { where: { id: string } }) =>
        args.where.id === SESSION_ID ? sessionRow : null,
      findMany: async () => [sessionRow],
      update: async () => {
        retargetWrites += 1
        return sessionRow
      },
    },
    scopeDisclosureGrant: { findMany: async () => [] },
    teamMember: { findMany: async () => [] },
    thread: {
      findFirst: async () => ({
        id: THREAD_ID,
        channel: {
          id: CHANNEL_ID,
          organizationId: ORGANIZATION_ID,
          systemChannelType: null,
          type: 'standard',
        },
      }),
    },
  } as unknown as PrismaClient

  const app = Fastify({ logger: false })
  registerThreadRoutes(app, {
    allowedCorsOrigins: [],
    buildChannelRealtimeScopes: () => [],
    config: { mode: 'selfHosted' },
    knowledgeProvider: {
      getPage: async () => null,
      getSpace: async () => {
        targetSpaceReads += 1
        return {
          channelId: null,
          createdBy: INSIDER_ID,
          id: SPACE_ID,
          memberAgentIds: [],
          memberUserIds: [],
          name: 'Private strategy',
          organizationId: ORGANIZATION_ID,
          privateToAgentId: null,
          projectId: '00000000-0000-4000-8000-000000000011',
          sensitivityTier: 'normal',
          teamId: null,
          userId: null,
          visibility: 'organization',
          writeRestricted: false,
        }
      },
      movePage: async () => null,
    },
    prisma,
    realtimeHub: {
      publishSse: async () => {
        publishedTargets += 1
      },
      publishWs: async () => undefined,
    },
    requireActorContext: () => actorContextFor(viewerUserId),
  } as unknown as Parameters<typeof registerThreadRoutes>[1])

  return {
    app,
    reads: () => ({ chunkReads, targetNameReads }),
    retargetEffects: () => ({ publishedTargets, retargetWrites, targetSpaceReads }),
  }
}

test('document-stream list and detail hide a run from a viewer who fails its basis', async () => {
  const { app, reads } = makeApp(OUTSIDER_ID)
  try {
    const list = await app.inject({
      method: 'GET',
      url: `/api/threads/${THREAD_ID}/document-streams?active=1`,
    })
    assert.equal(list.statusCode, 200)
    assert.deepEqual(list.json().data, { sessions: [] })
    assert.ok(!list.body.includes('Confidential launch'))
    assert.ok(!list.body.includes('Private strategy'))

    const detail = await app.inject({
      method: 'GET',
      url: `/api/threads/${THREAD_ID}/document-streams/${SESSION_ID}`,
    })
    const missing = await app.inject({
      method: 'GET',
      url: `/api/threads/${THREAD_ID}/document-streams/${MISSING_SESSION_ID}`,
    })
    assert.equal(detail.statusCode, 404)
    assert.deepEqual(detail.json(), missing.json(), 'restricted and absent must be indistinguishable')
    assert.ok(!detail.body.includes('Confidential launch'))
    assert.ok(!detail.body.includes('Nessie'))
    assert.deepEqual(
      reads(),
      { chunkReads: 0, targetNameReads: 0 },
      'restricted content and its target names were loaded before the basis gate',
    )
  } finally {
    await app.close()
  }
})

test('document-stream list and detail serve a viewer who satisfies the run basis', async () => {
  const { app } = makeApp(INSIDER_ID)
  try {
    const list = await app.inject({
      method: 'GET',
      url: `/api/threads/${THREAD_ID}/document-streams?active=1`,
    })
    assert.equal(list.statusCode, 200)
    const summary = list.json().data.sessions[0]
    assert.equal(summary.sessionId, SESSION_ID)
    assert.equal(summary.title, 'Confidential launch')
    assert.equal(summary.target.spaceName, 'Private strategy')

    const detail = await app.inject({
      method: 'GET',
      url: `/api/threads/${THREAD_ID}/document-streams/${SESSION_ID}`,
    })
    assert.equal(detail.statusCode, 200)
    assert.equal(detail.json().data.markdown, MARKDOWN)
    assert.equal(detail.json().data.offset, MARKDOWN.length)
    assert.equal(detail.json().data.session.sessionId, SESSION_ID)
  } finally {
    await app.close()
  }
})

test('retarget hides a restricted session and performs no target read or mutation', async () => {
  const { app, retargetEffects } = makeApp(OUTSIDER_ID)
  try {
    const retarget = await app.inject({
      method: 'POST',
      payload: { spaceId: SPACE_ID },
      url: `/api/threads/${THREAD_ID}/document-streams/${SESSION_ID}/target`,
    })
    const missing = await app.inject({
      method: 'POST',
      payload: { spaceId: SPACE_ID },
      url: `/api/threads/${THREAD_ID}/document-streams/${MISSING_SESSION_ID}/target`,
    })

    assert.equal(retarget.statusCode, 404)
    assert.deepEqual(
      retarget.json(),
      missing.json(),
      'retarget must not reveal whether the restricted session exists',
    )
    assert.ok(!retarget.body.includes('Confidential launch'))
    assert.deepEqual(retargetEffects(), {
      publishedTargets: 0,
      retargetWrites: 0,
      targetSpaceReads: 0,
    })
  } finally {
    await app.close()
  }
})

test('retarget remains available to a viewer who satisfies the run basis', async () => {
  const { app, retargetEffects } = makeApp(INSIDER_ID)
  try {
    const retarget = await app.inject({
      method: 'POST',
      payload: { spaceId: SPACE_ID },
      url: `/api/threads/${THREAD_ID}/document-streams/${SESSION_ID}/target`,
    })

    assert.equal(retarget.statusCode, 200)
    assert.equal(retarget.json().data.session.title, 'Confidential launch')
    assert.deepEqual(retargetEffects(), {
      publishedTargets: 1,
      retargetWrites: 1,
      targetSpaceReads: 1,
    })
  } finally {
    await app.close()
  }
})
