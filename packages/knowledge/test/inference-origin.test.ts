import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'

import {
  KnowledgeInferenceOriginError,
  requirePersistedKnowledgeOrigin,
} from '../src/inference-origin.js'

const INPUT = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  pageId: '22222222-2222-4222-8222-222222222222',
  systemComponent: 'knowledge-indexer',
  versionId: '33333333-3333-4333-8333-333333333333',
}

const prismaWithVersion = (
  page: { teamId: string | null; userId: string | null },
): PrismaClient =>
  ({
    knowledgePageVersion: {
      findFirst: async () => ({
        authorId: '44444444-4444-4444-8444-444444444444',
        authorType: 'user',
        page,
      }),
    },
  }) as unknown as PrismaClient

test('persisted knowledge origin carries user, team, system agent, and stable run', async () => {
  const origin = await requirePersistedKnowledgeOrigin(
    prismaWithVersion({
      teamId: '55555555-5555-4555-8555-555555555555',
      userId: null,
    }),
    INPUT,
  )

  assert.deepEqual(origin, {
    actorId: '44444444-4444-4444-8444-444444444444',
    actorType: 'user',
    agentId: '16c58b43-15d0-5c61-8f8b-e3e76d587e50',
    requestId:
      'knowledge-indexer:33333333-3333-4333-8333-333333333333',
    runId: INPUT.versionId,
    systemComponent: 'knowledge-indexer',
    teamId: '55555555-5555-4555-8555-555555555555',
    userId: '44444444-4444-4444-8444-444444444444',
  })
})

test('persisted knowledge origin fails closed when no team can be assigned', async () => {
  await assert.rejects(
    requirePersistedKnowledgeOrigin(
      prismaWithVersion({ teamId: null, userId: null }),
      INPUT,
    ),
    (error: unknown) =>
      error instanceof KnowledgeInferenceOriginError
      && error.code === 'KNOWLEDGE_INFERENCE_ORIGIN_REQUIRED',
  )
})
