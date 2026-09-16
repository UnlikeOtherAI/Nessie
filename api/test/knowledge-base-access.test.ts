import assert from 'node:assert/strict'
import test from 'node:test'

import { canManageKnowledgeSpaceAccess } from '../src/routes/knowledge-base-access.js'

const actor = {
  actor: { actorId: 'user-1', actorType: 'user' as const, roles: ['owner'] },
} as never

const viewer = (organizationRole: string | null) => ({
  baseEntitled: true,
  bypass: false,
  organizationRole,
  projectIds: new Set<string>(),
  uoaMembershipVerified: false,
  userId: 'user-1',
  visibleAgentIds: new Set<string>(),
})

test('a demoted local owner cannot manage a space from a stale session role', () => {
  assert.equal(
    canManageKnowledgeSpaceAccess({ createdBy: 'user-2' } as never, actor, viewer('member')),
    false,
  )
})

test('the creator remains able to manage their own space after a role change', () => {
  assert.equal(
    canManageKnowledgeSpaceAccess({ createdBy: 'user-1' } as never, actor, viewer('member')),
    true,
  )
})


test('the API knowledge adapter resolves one live proof and reuses it for the version viewer', async () => {
  const proof = {
    kind: 'uoa' as const,
    organizationId: 'org-1',
    organizationRole: 'member',
    teamIds: [],
    userId: 'user-1',
  }
  let liveReads = 0
  let viewerReads = 0
  const { createKnowledgeAccess } = await import('../src/routes/knowledge-base-access.js')
  const access = createKnowledgeAccess({
    knowledgeProvider: {} as never,
    prisma: {
      agent: { findMany: async () => [] },
      organizationMember: { findFirst: async () => null },
      projectMember: { findMany: async () => [] },
    },
    resolveDisclosureViewer: async (_prisma, _organizationId, _userId, authority) => {
      viewerReads += 1
      assert.equal(authority?.liveEntitlements, proof)
      return { kind: 'user', scopes: [], userId: 'user-1' }
    },
    resolveLiveEntitlements: async () => {
      liveReads += 1
      return proof
    },
  } as never)
  const built = await access.buildViewer({
    actionContext: { uoaIdentity: { organizationId: 'uoa-org', subject: 'subject', teamId: 'team', tokenVersion: 1 } },
    actor: { actorId: 'user-1', actorType: 'user' },
    tenant: { organizationId: 'org-1' },
  } as never)
  assert.equal(liveReads, 1)
  assert.equal(viewerReads, 1)
  assert.equal(built.baseEntitled, true)
})
