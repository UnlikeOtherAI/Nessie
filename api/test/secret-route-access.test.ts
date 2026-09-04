import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'

import { grantActiveSecret } from '../src/routes/secret-lifecycle.js'
import { secretDelegationAuthority } from '../src/routes/secret-route-access.js'

const ACTOR_ID = '10000000-0000-4000-8000-000000000001'
const SECRET_ID = '20000000-0000-4000-8000-000000000001'
const ORGANIZATION_ID = '30000000-0000-4000-8000-000000000001'
const TARGET_ID = '40000000-0000-4000-8000-000000000001'

const prismaWithPermissions = (permissions: string[], expiresAt: Date | null = null): PrismaClient => ({
  secretGrant: {
    findFirst: async () => ({ expiresAt, permissions }),
  },
} as unknown as PrismaClient)

test('a delegate cannot grant a secret capability they do not hold', async () => {
  const authority = await secretDelegationAuthority({
    actorId: ACTOR_ID,
    permissions: ['use'],
    prisma: prismaWithPermissions(['delegate']),
    secretId: SECRET_ID,
  })

  assert.equal(authority, null)
})

test('a delegate can grant only capabilities held alongside delegate', async () => {
  const canGrantUse = await secretDelegationAuthority({
    actorId: ACTOR_ID,
    permissions: ['use'],
    prisma: prismaWithPermissions(['delegate', 'use']),
    secretId: SECRET_ID,
  })
  const canGrantManage = await secretDelegationAuthority({
    actorId: ACTOR_ID,
    permissions: ['manage'],
    prisma: prismaWithPermissions(['delegate', 'use']),
    secretId: SECRET_ID,
  })

  assert.deepEqual(canGrantUse, { expiresAt: null })
  assert.equal(canGrantManage, null)
})

test('delegation authority preserves the source grant lifetime', async () => {
  const expiresAt = new Date('2030-01-01T00:00:00.000Z')
  const authority = await secretDelegationAuthority({
    actorId: ACTOR_ID,
    permissions: ['use'],
    prisma: prismaWithPermissions(['delegate', 'use'], expiresAt),
    secretId: SECRET_ID,
  })

  assert.deepEqual(authority, { expiresAt })
})

const grantPrisma = (sourceExpiry: Date, upserts: unknown[]): PrismaClient => {
  const tx = {
    $executeRaw: async () => 0,
    organizationMember: { findFirst: async () => ({ id: 'member' }) },
    secret: {
      findFirst: async () => ({
        id: SECRET_ID,
        organizationId: ORGANIZATION_ID,
        scopeId: 'project-id',
        scopeType: 'project',
        status: 'active',
      }),
    },
    secretGrant: {
      findFirst: async () => ({ expiresAt: sourceExpiry, permissions: ['delegate', 'use'] }),
      upsert: async (input: unknown) => {
        upserts.push(input)
        return { expiresAt: sourceExpiry, id: 'grant' }
      },
    },
  }
  return {
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient
}

test('a temporary delegate cannot mint an unbounded or longer-lived grant', async () => {
  const sourceExpiry = new Date('2030-01-01T00:00:00.000Z')
  const upserts: unknown[] = []
  const prisma = grantPrisma(sourceExpiry, upserts)
  const base = {
    actor: { actorId: ACTOR_ID, isOwner: false, organizationId: ORGANIZATION_ID },
    prisma,
    secretId: SECRET_ID,
  }
  const withoutExpiry = await grantActiveSecret({
    ...base,
    body: { permissions: ['use'], principalId: TARGET_ID, principalType: 'user' },
  })
  const afterSource = await grantActiveSecret({
    ...base,
    body: {
      expiresAt: '2030-01-02T00:00:00.000Z',
      permissions: ['use'],
      principalId: TARGET_ID,
      principalType: 'user',
    },
  })

  assert.deepEqual(withoutExpiry, { ok: false, reason: 'denied' })
  assert.deepEqual(afterSource, { ok: false, reason: 'denied' })
  assert.equal(upserts.length, 0)
})

test('a temporary delegate may grant a held capability for a shorter lifetime', async () => {
  const upserts: unknown[] = []
  const result = await grantActiveSecret({
    actor: { actorId: ACTOR_ID, isOwner: false, organizationId: ORGANIZATION_ID },
    body: {
      expiresAt: '2029-12-31T00:00:00.000Z',
      permissions: ['use'],
      principalId: TARGET_ID,
      principalType: 'user',
    },
    prisma: grantPrisma(new Date('2030-01-01T00:00:00.000Z'), upserts),
    secretId: SECRET_ID,
  })

  assert.equal(result.ok, true)
  assert.equal(upserts.length, 1)
})
