import assert from 'node:assert/strict'
import test from 'node:test'

import { canManageSecret } from '../src/services/secret-vault-write.js'

const OWNER_ACTOR = { actor: { actorId: 'owner-1', roles: ['owner'] } }
const MEMBER_ACTOR = { actor: { actorId: 'member-1', roles: ['member'] } }

const ORG_SECRET = { id: 'secret-1', scopeType: 'organization' as const, scopeId: 'org-1' }
const PERSONAL_SECRET = { id: 'secret-2', scopeType: 'personal' as const, scopeId: 'member-1' }

/**
 * `canManageSecret` (`api/src/services/secret-vault-write.ts`) is the single
 * definition of the three-way OR (owner / personal-scope owner / explicit
 * grant) that used to be copy-pasted verbatim across the rotate, revoke, and
 * grant handlers in `api/src/routes/secrets.ts` (S1-F1-1). This proves the
 * composed rule still resolves each branch correctly rather than just
 * asserting the routes wire it in.
 */

test('canManageSecret: an organization owner may manage a shared scope, never a personal one', async () => {
  const prisma = { secretGrant: { findFirst: async () => null } }
  assert.equal(await canManageSecret(OWNER_ACTOR, ORG_SECRET, 'manage', prisma), true)
  assert.equal(await canManageSecret(OWNER_ACTOR, PERSONAL_SECRET, 'delegate', prisma), false)
})

test('canManageSecret: the personal-scope owner may manage their own secret without a grant', async () => {
  const prisma = { secretGrant: { findFirst: async () => null } }
  assert.equal(await canManageSecret(MEMBER_ACTOR, PERSONAL_SECRET, 'manage', prisma), true)
})

test('canManageSecret: a non-owner cannot manage another person\'s personal secret', async () => {
  const prisma = { secretGrant: { findFirst: async () => null } }
  const otherPersonalSecret = { id: 'secret-3', scopeType: 'personal' as const, scopeId: 'someone-else' }
  assert.equal(await canManageSecret(MEMBER_ACTOR, otherPersonalSecret, 'manage', prisma), false)
})

test('canManageSecret: an org-scope secret is refused for a non-owner with no grant', async () => {
  const prisma = { secretGrant: { findFirst: async () => null } }
  assert.equal(await canManageSecret(MEMBER_ACTOR, ORG_SECRET, 'manage', prisma), false)
})

test('canManageSecret: an explicit grant for the exact permission is honored', async () => {
  let queriedPermission: string | undefined
  const prisma = {
    secretGrant: {
      findFirst: async ({ where }: { where: { permissions: { has: string } } }) => {
        queriedPermission = where.permissions.has
        return { id: 'grant-1' }
      },
    },
  }
  assert.equal(await canManageSecret(MEMBER_ACTOR, ORG_SECRET, 'delegate', prisma), true)
  assert.equal(queriedPermission, 'delegate')
})

test('canManageSecret: a valid explicit user grant can delegate another personal secret', async () => {
  const prisma = { secretGrant: { findFirst: async () => ({ id: 'grant-1' }) } }
  assert.equal(await canManageSecret(OWNER_ACTOR, PERSONAL_SECRET, 'delegate', prisma), true)
})

test('secretsVisibleToActor: an organization owner cannot list another person’s metadata', async () => {
  const { secretsVisibleToActor } = await import('../src/services/secret-vault-write.js')
  let where: unknown
  const prisma = {
    secret: {
      findMany: async (input: { where: unknown }) => {
        where = input.where
        return []
      },
    },
  }

  await secretsVisibleToActor({
    actorId: 'owner-1',
    isOwner: true,
    organizationId: 'org-1',
    prisma: prisma as never,
  })

  const ownerWhere = where as {
    OR: Array<{ scopeId?: string; scopeType?: unknown; grants?: { some: unknown } }>
    organizationId: string
  }
  assert.equal(ownerWhere.organizationId, 'org-1')
  assert.deepEqual(ownerWhere.OR[0], { scopeType: { not: 'personal' } })
  assert.deepEqual(ownerWhere.OR[1], { scopeType: 'personal', scopeId: 'owner-1' })
  const delegated = ownerWhere.OR[2]?.grants?.some as {
    OR: Array<{ expiresAt: null } | { expiresAt: { gt: Date } }>
    permissions: { hasSome: string[] }
    principalId: string
    principalType: string
  }
  assert.equal(delegated.principalType, 'user')
  assert.equal(delegated.principalId, 'owner-1')
  assert.deepEqual(delegated.permissions.hasSome, ['manage', 'delegate'])
  assert.ok(delegated.OR[1] && 'expiresAt' in delegated.OR[1])
  assert.ok((delegated.OR[1] as { expiresAt: { gt: unknown } }).expiresAt.gt instanceof Date)
})

test('secretsVisibleToActor: a personal use or reveal grant alone does not list metadata', async () => {
  const { secretsVisibleToActor } = await import('../src/services/secret-vault-write.js')
  let where: { OR?: unknown[] } | undefined
  const prisma = {
    projectMember: { findMany: async () => [] },
    secret: {
      findMany: async (input: { where: { OR?: unknown[] } }) => {
        where = input.where
        return []
      },
    },
    teamMember: { findMany: async () => [] },
  }

  await secretsVisibleToActor({
    actorId: 'member-1',
    isOwner: false,
    organizationId: 'org-1',
    prisma: prisma as never,
  })

  const personalGrant = where?.OR?.find((candidate) =>
    (candidate as { scopeType?: string }).scopeType === 'personal'
    && 'grants' in (candidate as object),
  ) as { grants: { some: { permissions: { hasSome: string[] } } } } | undefined
  assert.deepEqual(personalGrant?.grants.some.permissions.hasSome, ['manage', 'delegate'])
})
