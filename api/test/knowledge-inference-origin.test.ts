import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { KnowledgeInferenceOriginError } from '@nessie/knowledge'

import { enqueueKnowledgeExtract } from '../src/routes/knowledge-base-file-extract.js'
import {
  enterKnowledgeInferenceActorContext,
  requireApiKnowledgeInferenceOrigin,
  runKnowledgeInferenceRequestContext,
  withKnowledgeInferenceActorContext,
} from '../src/services/knowledge-inference-origin.js'

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111'
const PROJECT_ID = '22222222-2222-4222-8222-222222222222'
const TEAM_ID = '33333333-3333-4333-8333-333333333333'
const USER_ID = '44444444-4444-4444-8444-444444444444'
const PAGE_ID = '55555555-5555-4555-8555-555555555555'
const VERSION_ID = '66666666-6666-4666-8666-666666666666'

const actorContext = (
  teamId?: string,
  overrides: {
    organizationId?: string
    requestId?: string
    userId?: string
  } = {},
): AuthorizedActionContext => ({
  actor: {
    actorId: overrides.userId ?? USER_ID,
    actorType: 'user',
    roles: ['member'],
  },
  actionContext: {
    requestId: overrides.requestId ?? 'knowledge-request-1',
  },
  tenant: {
    organizationId: overrides.organizationId ?? ORGANIZATION_ID,
    projectId: PROJECT_ID,
    ...(teamId ? { teamId } : {}),
  },
})

const event = {
  organizationId: ORGANIZATION_ID,
  pageId: PAGE_ID,
  versionId: VERSION_ID,
}

test('teamless project page keeps the authenticated request team in its job origin', async () => {
  let persistedLookupCalls = 0
  const prisma = {
    knowledgePageVersion: {
      findFirst: async () => {
        persistedLookupCalls += 1
        return {
          authorId: USER_ID,
          authorType: 'user',
          page: { teamId: null, userId: null },
        }
      },
    },
  } as unknown as PrismaClient

  const origin = await withKnowledgeInferenceActorContext(
    actorContext(TEAM_ID),
    () => requireApiKnowledgeInferenceOrigin(
      prisma,
      event,
      'knowledge-indexer',
    ),
  )

  assert.equal(persistedLookupCalls, 0)
  assert.equal(origin.userId, USER_ID)
  assert.equal(origin.teamId, TEAM_ID)
  assert.equal(origin.runId, VERSION_ID)
  assert.equal(origin.systemComponent, 'knowledge-indexer')
})

test('teamless project mutation fails explicitly when the request has no team', async () => {
  const prisma = {} as PrismaClient

  await assert.rejects(
    withKnowledgeInferenceActorContext(
      actorContext(),
      () => requireApiKnowledgeInferenceOrigin(
        prisma,
        event,
        'knowledge-indexer',
      ),
    ),
    (error: unknown) =>
      error instanceof KnowledgeInferenceOriginError
      && error.code === 'KNOWLEDGE_INFERENCE_ORIGIN_REQUIRED',
  )
})

test('concurrent request roots keep interleaved knowledge identities isolated', async () => {
  const organizationB = '77777777-7777-4777-8777-777777777777'
  const teamB = '88888888-8888-4888-8888-888888888888'
  const userB = '99999999-9999-4999-8999-999999999999'
  const versionB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const ready = {
    count: 0,
    release: undefined as (() => void) | undefined,
  }
  const barrier = new Promise<void>((resolve) => {
    ready.release = resolve
  })
  const prisma = {
    knowledgePageVersion: {
      findFirst: async () => {
        throw new Error('persisted lookup must not run inside request context')
      },
    },
  } as unknown as PrismaClient

  const resolveRequest = (
    context: AuthorizedActionContext,
    requestEvent: typeof event,
  ) => runKnowledgeInferenceRequestContext(async () => {
    enterKnowledgeInferenceActorContext(context)
    ready.count += 1
    if (ready.count === 2) ready.release?.()
    await barrier
    await new Promise<void>((resolve) => setImmediate(resolve))
    return requireApiKnowledgeInferenceOrigin(
      prisma,
      requestEvent,
      'knowledge-indexer',
    )
  })

  const [originA, originB] = await Promise.all([
    resolveRequest(actorContext(TEAM_ID), event),
    resolveRequest(
      actorContext(teamB, {
        organizationId: organizationB,
        requestId: 'knowledge-request-2',
        userId: userB,
      }),
      {
        organizationId: organizationB,
        pageId: PAGE_ID,
        versionId: versionB,
      },
    ),
  ])

  assert.deepEqual(
    {
      requestId: originA.requestId,
      runId: originA.runId,
      teamId: originA.teamId,
      userId: originA.userId,
    },
    {
      requestId: 'knowledge-request-1',
      runId: VERSION_ID,
      teamId: TEAM_ID,
      userId: USER_ID,
    },
  )
  assert.deepEqual(
    {
      requestId: originB.requestId,
      runId: originB.runId,
      teamId: originB.teamId,
      userId: originB.userId,
    },
    {
      requestId: 'knowledge-request-2',
      runId: versionB,
      teamId: teamB,
      userId: userB,
    },
  )
})

test('failed first-version extraction appends a compensating create audit', async () => {
  const auditRows: Array<Record<string, unknown>> = []
  let deletedPages = 0
  const tx = {
    $executeRaw: async () => 0,
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditRows.push(data)
        return data
      },
      // The hash-chain audit writer reads the current chain tip first.
      findFirst: async () => null,
    },
    knowledgePageVersion: {
      count: async () => 1,
    },
    knowledgePage: {
      deleteMany: async () => {
        deletedPages += 1
        return { count: 1 }
      },
    },
  }
  const prisma = {
    $transaction: async (
      operation: (transaction: typeof tx) => Promise<unknown>,
    ) => operation(tx),
  } as unknown as PrismaClient

  await assert.rejects(
    withKnowledgeInferenceActorContext(
      actorContext(),
      () => enqueueKnowledgeExtract(prisma, {
        organizationId: ORGANIZATION_ID,
        pageId: PAGE_ID,
        versionId: VERSION_ID,
        attachmentId: 'attachment-1',
        filename: 'notes.txt',
        mime: 'text/plain',
      }),
    ),
    (error: unknown) =>
      error instanceof KnowledgeInferenceOriginError
      && error.code === 'KNOWLEDGE_INFERENCE_ORIGIN_REQUIRED',
  )

  assert.equal(deletedPages, 1)
  assert.equal(auditRows.length, 1)
  assert.equal(auditRows[0]?.['action'], 'kb.page.created')
  assert.equal(auditRows[0]?.['outcome'], 'error')
  assert.equal(auditRows[0]?.['reason'], 'KNOWLEDGE_INFERENCE_ORIGIN_REQUIRED')
  assert.deepEqual(auditRows[0]?.['metadata'], {
    compensatesOutcome: 'success',
    rolledBack: true,
  })
})
