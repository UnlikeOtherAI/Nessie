import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import Fastify from 'fastify'
import { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { registerWebPushRoutes } from '../src/routes/web-push.js'
import {
  MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER,
  trimWebPushSubscriptionCap,
} from '../src/services/web-push-subscriptions.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip
const endpoint = 'https://push.example.test/subscription'
const organizationA = '00000000-0000-4000-8000-000000000001'
const organizationB = '00000000-0000-4000-8000-000000000002'
const userA = '00000000-0000-4000-8000-00000000000a'
const userB = '00000000-0000-4000-8000-00000000000b'

const actor = (organizationId: string, userId: string): AuthorizedActionContext => ({
  actionContext: { requestId: `web-push-${organizationId}-${userId}` },
  actor: { actorId: userId, actorType: 'user', roles: ['member'] },
  tenant: { organizationId, projectId: null },
})

test('current-tenant config and removal never expose another user or tenant enrollment', async () => {
  let current = actor(organizationA, userA)
  const rows = [
    { id: 'a', organizationId: organizationA, userId: userA, endpoint },
    { id: 'b', organizationId: organizationB, userId: userA, endpoint },
    { id: 'c', organizationId: organizationA, userId: userB, endpoint },
  ]
  const prisma = {
    webPushSubscription: {
      deleteMany: async ({ where }: { where: { endpoint: string; organizationId?: string; userId: string } }) => {
        const before = rows.length
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          const row = rows[index]
          if (row && row.endpoint === where.endpoint && (!where.organizationId || row.organizationId === where.organizationId) && row.userId === where.userId) {
            rows.splice(index, 1)
          }
        }
        return { count: before - rows.length }
      },
      findMany: async ({ where }: { where: { organizationId: string; userId: string } }) =>
        rows.filter((row) => row.organizationId === where.organizationId && row.userId === where.userId),
    },
  } as unknown as PrismaClient
  const app = Fastify({ logger: false })
  registerWebPushRoutes(app, {
    config: { webPush: { privateKey: 'private', publicKey: 'public', subject: 'mailto:ops@example.test' } },
    prisma,
    requireActorContext: () => current,
  } as never)

  try {
    const first = await app.inject({ method: 'GET', url: '/api/push/web/config' })
    assert.deepEqual(first.json(), { data: { enabled: true, publicKey: 'public', registeredEndpoints: [endpoint] } })

    current = actor(organizationB, userA)
    const switchedTenant = await app.inject({ method: 'GET', url: '/api/push/web/config' })
    assert.deepEqual(switchedTenant.json().data.registeredEndpoints, [endpoint])

    current = actor(organizationA, userB)
    const switchedUser = await app.inject({ method: 'GET', url: '/api/push/web/config' })
    assert.deepEqual(switchedUser.json().data.registeredEndpoints, [endpoint])

    current = actor(organizationB, userB)
    const otherPerson = await app.inject({ method: 'GET', url: '/api/push/web/config' })
    assert.deepEqual(otherPerson.json().data.registeredEndpoints, [])

    const deniedRemoval = await app.inject({
      method: 'POST',
      url: '/api/push/web/unsubscribe',
      payload: { endpoint },
    })
    assert.equal(deniedRemoval.statusCode, 204)
    assert.equal(rows.length, 3)

    current = actor(organizationA, userA)
    const removed = await app.inject({
      method: 'POST',
      url: '/api/push/web/unsubscribe',
      payload: { endpoint },
    })
    assert.equal(removed.statusCode, 204)
    assert.deepEqual(rows.map((row) => row.id), ['b', 'c'])

    const disabledInA = await app.inject({ method: 'GET', url: '/api/push/web/config' })
    assert.deepEqual(disabledInA.json().data.registeredEndpoints, [])

    current = actor(organizationB, userA)
    const stillEnabledInB = await app.inject({ method: 'GET', url: '/api/push/web/config' })
    assert.deepEqual(stillEnabledInB.json().data.registeredEndpoints, [endpoint])

    const logout = await app.inject({
      method: 'POST',
      url: '/api/push/web/logout',
      payload: { endpoint },
    })
    assert.equal(logout.statusCode, 204)
    assert.deepEqual(rows.map((row) => row.id), ['c'])

    current = actor(organizationB, userB)
    const replacementPerson = await app.inject({ method: 'GET', url: '/api/push/web/config' })
    assert.deepEqual(replacementPerson.json().data.registeredEndpoints, [])
  } finally {
    await app.close()
  }
})

test('cap eviction keeps another organization enrollment intact', async () => {
  const rows = [
    ...Array.from({ length: MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER + 1 }, (_, index) => ({
      id: `a-${index}`,
      organizationId: organizationA,
      userId: userA,
      lastSeenAt: new Date(index),
    })),
    ...Array.from({ length: MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER + 1 }, (_, index) => ({
      id: `b-${index}`,
      organizationId: organizationB,
      userId: userA,
      lastSeenAt: new Date(index),
    })),
  ]
  const prisma = {
    webPushSubscription: {
      count: async ({ where }: { where: { organizationId: string; userId: string } }) =>
        rows.filter((row) => row.organizationId === where.organizationId && row.userId === where.userId).length,
      deleteMany: async ({ where }: { where: { id: { in: string[] }; organizationId: string; userId: string } }) => {
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          const row = rows[index]
          if (row && row.organizationId === where.organizationId && row.userId === where.userId && where.id.in.includes(row.id)) {
            rows.splice(index, 1)
          }
        }
        return { count: 1 }
      },
      findMany: async ({ where, take }: { where: { organizationId: string; userId: string }; take: number }) =>
        rows
          .filter((row) => row.organizationId === where.organizationId && row.userId === where.userId)
          .sort((left, right) => left.lastSeenAt.getTime() - right.lastSeenAt.getTime())
          .slice(0, take)
          .map((row) => ({ id: row.id })),
    },
  } as unknown as PrismaClient

  await trimWebPushSubscriptionCap(prisma, { organizationId: organizationA, userId: userA })

  assert.equal(rows.filter((row) => row.organizationId === organizationA).length, MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER)
  assert.equal(rows.filter((row) => row.organizationId === organizationB).length, MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER + 1)
})

runDatabaseTest('the migrated unique index permits shared browser enrollment in two organizations', async () => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const [firstOrg, secondOrg, user] = await Promise.all([
    prisma.organization.create({ data: { name: `web-push-a-${suffix}` } }),
    prisma.organization.create({ data: { name: `web-push-b-${suffix}` } }),
    prisma.user.create({ data: { displayName: `Web push ${suffix}`, email: `web-push-${suffix}@example.test` } }),
  ])
  const sharedEndpoint = `https://push.example.test/${suffix}`
  try {
    await prisma.webPushSubscription.createMany({
      data: [
        { organizationId: firstOrg.id, userId: user.id, endpoint: sharedEndpoint, p256dh: 'p256dh-a', auth: 'auth-a' },
        { organizationId: secondOrg.id, userId: user.id, endpoint: sharedEndpoint, p256dh: 'p256dh-b', auth: 'auth-b' },
      ],
    })
    const removed = await prisma.webPushSubscription.deleteMany({
      where: { organizationId: firstOrg.id, userId: user.id, endpoint: sharedEndpoint },
    })
    assert.equal(removed.count, 1)
    assert.equal(
      await prisma.webPushSubscription.count({ where: { organizationId: secondOrg.id, userId: user.id, endpoint: sharedEndpoint } }),
      1,
    )
  } finally {
    await prisma.webPushSubscription.deleteMany({ where: { userId: user.id } })
    await prisma.user.delete({ where: { id: user.id } })
    await prisma.organization.deleteMany({ where: { id: { in: [firstOrg.id, secondOrg.id] } } })
    await prisma.$disconnect()
  }
})
