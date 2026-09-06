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

test('canManageSecret: an organization owner may manage any scope', async () => {
  const prisma = { secretGrant: { findFirst: async () => null } }
  assert.equal(await canManageSecret(OWNER_ACTOR, ORG_SECRET, 'manage', prisma), true)
  assert.equal(await canManageSecret(OWNER_ACTOR, PERSONAL_SECRET, 'delegate', prisma), true)
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
