import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  advanceUoaLocalSessionBinding,
  resolveUoaLocalSessionContext,
  UoaLocalSessionBindingError,
} from '../src/services/uoa-session-context.js'

const USER_ID = '00000000-0000-4000-8000-000000000001'
const IDENTITY = {
  organizationId: 'uoa-org',
  subject: 'uoa-user',
  teamId: 'uoa-team',
  tokenVersion: 7,
} as const

class FakeBindingPrisma {
  teamAvailable = true
  link = {
    activeOrgId: IDENTITY.organizationId,
    activeTeamId: IDENTITY.teamId,
    id: '00000000-0000-4000-8000-000000000010',
    status: 'linked',
    uoaSub: IDENTITY.subject,
    uoaTokenVersion: IDENTITY.tokenVersion,
  }
  siblingLinks = [
    {
      id: '00000000-0000-4000-8000-000000000011',
      productSlug: 'deep-water',
      uoaTokenVersion: IDENTITY.tokenVersion as number | null,
    },
    {
      id: '00000000-0000-4000-8000-000000000012',
      productSlug: 'deepsignal',
      uoaTokenVersion: IDENTITY.tokenVersion as number | null,
    },
  ]

  readonly team = {
    findFirst: async (input: {
      where: {
        externalOrgId: string
        externalWorkspaceId: string
        members: { some: { userId: string } }
      }
    }) => {
      assert.equal(input.where.externalOrgId, IDENTITY.organizationId)
      assert.equal(input.where.externalWorkspaceId, IDENTITY.teamId)
      assert.equal(input.where.members.some.userId, USER_ID)
      if (!this.teamAvailable) return null
      return {
        id: '00000000-0000-4000-8000-000000000020',
        projectId: '00000000-0000-4000-8000-000000000030',
        project: {
          organizationId: '00000000-0000-4000-8000-000000000040',
          organization: { members: [{ role: 'owner' }] },
        },
      }
    },
  }

  readonly productAccountLink = {
    findUnique: async (input: {
      where: {
        organizationId_userId_productSlug: {
          organizationId: string
          productSlug: string
          userId: string
        }
      }
    }) => {
      assert.deepEqual(input.where.organizationId_userId_productSlug, {
        organizationId: '00000000-0000-4000-8000-000000000040',
        productSlug: 'nessie',
        userId: USER_ID,
      })
      return { ...this.link }
    },
    findMany: async () => [
      { ...this.link, productSlug: 'nessie' },
      ...this.siblingLinks.map((link) => ({ ...link })),
    ],
    updateMany: async (input: {
      where: {
        id: { in: string[] }
      }
      data: { uoaTokenVersion: number }
    }) => {
      let count = 0
      if (input.where.id.in.includes(this.link.id)) {
        this.link.uoaTokenVersion = input.data.uoaTokenVersion
        count += 1
      }
      for (const link of this.siblingLinks) {
        if (!input.where.id.in.includes(link.id)) continue
        link.uoaTokenVersion = input.data.uoaTokenVersion
        count += 1
      }
      return { count }
    },
  }

  async $transaction<T>(operation: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return operation(this.asClient())
  }

  asClient(): PrismaClient {
    return this as unknown as PrismaClient
  }
}

test('resolves the exact UOA-bound Nessie workspace and live role', async () => {
  const fake = new FakeBindingPrisma()

  assert.deepEqual(
    await resolveUoaLocalSessionContext(fake.asClient(), {
      identity: IDENTITY,
      userId: USER_ID,
    }),
    {
      organizationId: '00000000-0000-4000-8000-000000000040',
      projectId: '00000000-0000-4000-8000-000000000030',
      role: 'owner',
      teamId: '00000000-0000-4000-8000-000000000020',
    },
  )
})

test('rejects first-membership fallback and mutable-link drift', async () => {
  const missingTeam = new FakeBindingPrisma()
  missingTeam.teamAvailable = false
  await assert.rejects(
    resolveUoaLocalSessionContext(missingTeam.asClient(), {
      identity: IDENTITY,
      userId: USER_ID,
    }),
    UoaLocalSessionBindingError,
  )

  const staleLink = new FakeBindingPrisma()
  staleLink.link.uoaTokenVersion = 6
  await assert.rejects(
    resolveUoaLocalSessionContext(staleLink.asClient(), {
      identity: IDENTITY,
      userId: USER_ID,
    }),
    UoaLocalSessionBindingError,
  )
})

test('advances every exact first-party link to the same monotonic epoch', async () => {
  const fake = new FakeBindingPrisma()
  const nextIdentity = { ...IDENTITY, tokenVersion: 8 }

  const context = await advanceUoaLocalSessionBinding(fake.asClient(), {
    nextIdentity,
    previousIdentity: IDENTITY,
    userId: USER_ID,
  })

  assert.equal(fake.link.uoaTokenVersion, 8)
  assert.deepEqual(fake.siblingLinks.map((link) => link.uoaTokenVersion), [8, 8])
  assert.equal(context.teamId, '00000000-0000-4000-8000-000000000020')
  assert.deepEqual(
    await resolveUoaLocalSessionContext(fake.asClient(), {
      identity: nextIdentity,
      userId: USER_ID,
    }),
    context,
  )
})

test('concurrent replay accepts an already-advanced epoch but rejects a changed tuple', async () => {
  const fake = new FakeBindingPrisma()
  fake.link.uoaTokenVersion = 8
  await advanceUoaLocalSessionBinding(fake.asClient(), {
    nextIdentity: { ...IDENTITY, tokenVersion: 8 },
    previousIdentity: IDENTITY,
    userId: USER_ID,
  })

  await assert.rejects(
    advanceUoaLocalSessionBinding(fake.asClient(), {
      nextIdentity: { ...IDENTITY, teamId: 'different-team', tokenVersion: 8 },
      previousIdentity: IDENTITY,
      userId: USER_ID,
    }),
    UoaLocalSessionBindingError,
  )
})
