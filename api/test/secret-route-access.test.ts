import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'

import { hasEverySecretPermission } from '../src/routes/secret-route-access.js'

const ACTOR_ID = '10000000-0000-4000-8000-000000000001'
const SECRET_ID = '20000000-0000-4000-8000-000000000001'

const prismaWithPermissions = (permissions: string[]): PrismaClient => ({
  secretGrant: {
    findFirst: async () => ({ permissions }),
  },
} as unknown as PrismaClient)

test('a delegate cannot grant a secret capability they do not hold', async () => {
  const canGrantUse = await hasEverySecretPermission({
    actorId: ACTOR_ID,
    permissions: ['use'],
    prisma: prismaWithPermissions(['delegate']),
    secretId: SECRET_ID,
  })

  assert.equal(canGrantUse, false)
})

test('a delegate can grant only capabilities held alongside delegate', async () => {
  const canGrantUse = await hasEverySecretPermission({
    actorId: ACTOR_ID,
    permissions: ['use'],
    prisma: prismaWithPermissions(['delegate', 'use']),
    secretId: SECRET_ID,
  })
  const canGrantManage = await hasEverySecretPermission({
    actorId: ACTOR_ID,
    permissions: ['manage'],
    prisma: prismaWithPermissions(['delegate', 'use']),
    secretId: SECRET_ID,
  })

  assert.equal(canGrantUse, true)
  assert.equal(canGrantManage, false)
})
