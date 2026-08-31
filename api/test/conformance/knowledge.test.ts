import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { registerKnowledgeBaseRoutes } from '../../src/routes/knowledge-base.js'
import { IDS, foreignOwner } from './harness.js'

/**
 * The knowledge base delegates row-level `organizationId` filtering to the
 * `KnowledgeProvider` (the first-party provider scopes in SQL; that scoping is
 * proven in the `@nessie/knowledge` package tests). What the *route* layer owns
 * — and what this conformance case pins — is that the org handed to the provider
 * is always the authenticated caller's tenant, never a value a client could
 * influence. A foreign owner therefore can only ever query their own org.
 */
test('GET /api/knowledge-base/spaces forwards the caller\'s org to the provider', async () => {
  const seenOrgIds: string[] = []
  const actor: AuthorizedActionContext = foreignOwner()

  const provider = {
    listSpaces: async (input: { organizationId: string }) => {
      seenOrgIds.push(input.organizationId)
      return { data: [], meta: { cursor: null, hasMore: false } }
    },
  }

  // A policy-allow for the caller's org + their own project membership, so the
  // `knowledge_space:view` gate passes and the handler reaches `listSpaces`.
  const prisma = {
    $queryRaw: async () => [
      {
        id: '00000000-0000-4000-8000-0000000000f0',
        scope: 'organization',
        scopeId: IDS.orgB,
        resourceType: 'knowledge_space',
        action: 'view',
        effect: 'allow',
        priority: 10,
        conditions: null,
        actorType: 'role',
        actorId: '*',
      },
    ],
    projectMember: { findMany: async () => [{ projectId: IDS.projectB }] },
    // This fixture contains no agents. The user viewer still resolves the
    // shared agent-visibility query, so the delegate must exist and return the
    // empty result for every scoped where/select combination.
    agent: { findMany: async () => [] },
    agentBinding: { findMany: async () => [] },
    knowledgeSpaceMember: { findMany: async () => [] },
  }

  const app = Fastify({ logger: false })
  registerKnowledgeBaseRoutes(app, {
    prisma,
    knowledgeProvider: provider,
    requireActorContext: () => actor,
  } as unknown as Parameters<typeof registerKnowledgeBaseRoutes>[1])

  // Even if a client tries to smuggle a foreign org in the query, the route must
  // ignore it and use the authenticated tenant.
  const res = await app.inject({
    method: 'GET',
    url: `/api/knowledge-base/spaces?organizationId=${IDS.orgA}`,
  })

  assert.equal(res.statusCode, 200)
  // The caller's org (orgB) is used; the smuggled orgA is never forwarded.
  assert.deepEqual(seenOrgIds, [IDS.orgB])
  await app.close()
})
