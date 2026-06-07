import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { registerDeviceRoutes } from '../src/routes/devices.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const userA = '00000000-0000-4000-8000-00000000000a'
const userB = '00000000-0000-4000-8000-00000000000b'

type DeviceRow = {
  id: string
  organizationId: string
  userId: string
  platform: string
  token: string
  appVersion: string | null
  lastSeenAt: Date
  createdAt: Date
}

const actorContextFor = (userId: string): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles: ['member'] },
  tenant: { organizationId, projectId },
  actionContext: { requestId: `req-devices-${userId}` },
})

/**
 * In-memory `deviceToken` store reproducing the (userId, token) unique upsert
 * and scoped deleteMany the route relies on. Shared across the app so we can
 * assert cross-call behaviour (idempotent re-register, scoped delete).
 */
const makeApp = (userId: string, rows: DeviceRow[] = []) => {
  const prisma = {
    deviceToken: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { userId_token: { userId: string; token: string } }
        create: Omit<DeviceRow, 'id' | 'lastSeenAt' | 'createdAt'> & {
          appVersion?: string
        }
        update: { platform: string; appVersion: string | null; lastSeenAt: Date }
      }) => {
        const existing = rows.find(
          (r) => r.userId === where.userId_token.userId && r.token === where.userId_token.token,
        )
        if (existing) {
          existing.platform = update.platform
          existing.appVersion = update.appVersion
          existing.lastSeenAt = update.lastSeenAt
          return existing
        }
        const now = new Date()
        const created: DeviceRow = {
          id: randomUUID(),
          organizationId: create.organizationId,
          userId: create.userId,
          platform: create.platform,
          token: create.token,
          appVersion: create.appVersion ?? null,
          lastSeenAt: now,
          createdAt: now,
        }
        rows.push(created)
        return created
      },
      deleteMany: async ({ where }: { where: { userId: string; token: string } }) => {
        const before = rows.length
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (rows[i]?.userId === where.userId && rows[i]?.token === where.token) {
            rows.splice(i, 1)
          }
        }
        return { count: before - rows.length }
      },
    },
  } as unknown as PrismaClient

  const app = Fastify({ logger: false })
  registerDeviceRoutes(app, {
    prisma,
    requireActorContext: () => actorContextFor(userId),
  } as unknown as Parameters<typeof registerDeviceRoutes>[1])
  return { app, rows }
}

test('POST /api/devices registers a new native device token for the caller', async () => {
  const { app, rows } = makeApp(userA)
  const response = await app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'apns-token-1', appVersion: '1.2.3' },
  })

  assert.equal(response.statusCode, 201)
  const payload = response.json() as { data: Record<string, unknown> }
  assert.equal(payload.data['platform'], 'ios')
  assert.equal(payload.data['token'], 'apns-token-1')
  assert.equal(payload.data['appVersion'], '1.2.3')
  // The token is scoped to the caller's user + org.
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.userId, userA)
  assert.equal(rows[0]?.organizationId, organizationId)
  // The response must not leak tenant internals.
  assert.equal('organizationId' in payload.data, false)
  assert.equal('userId' in payload.data, false)
  await app.close()
})

test('POST /api/devices upserts (same user+token updates, no duplicate row)', async () => {
  const { app, rows } = makeApp(userA)
  await app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'apns-token-1', appVersion: '1.0.0' },
  })
  const firstSeenAt = rows[0]?.lastSeenAt
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = await app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'android', token: 'apns-token-1', appVersion: '2.0.0' },
  })

  assert.equal(second.statusCode, 201)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.platform, 'android')
  assert.equal(rows[0]?.appVersion, '2.0.0')
  assert.ok(rows[0] && firstSeenAt && rows[0].lastSeenAt.getTime() >= firstSeenAt.getTime())
  await app.close()
})

test('DELETE /api/devices/:token removes the caller token and is idempotent', async () => {
  const { app, rows } = makeApp(userA)
  await app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'apns-token-1' },
  })
  assert.equal(rows.length, 1)

  const first = await app.inject({ method: 'DELETE', url: '/api/devices/apns-token-1' })
  assert.equal(first.statusCode, 204)
  assert.equal(rows.length, 0)

  // Deleting an absent token is still a no-op success.
  const second = await app.inject({ method: 'DELETE', url: '/api/devices/apns-token-1' })
  assert.equal(second.statusCode, 204)
  assert.equal(rows.length, 0)
  await app.close()
})

test('a user cannot delete another user token (scoped on userId)', async () => {
  // userA owns the token; the DELETE call is authenticated as userB.
  const rows: DeviceRow[] = [
    {
      id: randomUUID(),
      organizationId,
      userId: userA,
      platform: 'ios',
      token: 'apns-token-shared',
      appVersion: null,
      lastSeenAt: new Date(),
      createdAt: new Date(),
    },
  ]
  const { app } = makeApp(userB, rows)

  const response = await app.inject({ method: 'DELETE', url: '/api/devices/apns-token-shared' })
  assert.equal(response.statusCode, 204)
  // userA's row is untouched — the scoped deleteMany matched nothing for userB.
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.userId, userA)
  await app.close()
})

test('a user re-registering an existing token value gets their own row, not the other user row', async () => {
  // userA already owns "shared-token". userB registers the same token string.
  const rows: DeviceRow[] = [
    {
      id: randomUUID(),
      organizationId,
      userId: userA,
      platform: 'ios',
      token: 'shared-token',
      appVersion: null,
      lastSeenAt: new Date(),
      createdAt: new Date(),
    },
  ]
  const { app } = makeApp(userB, rows)

  const response = await app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'android', token: 'shared-token' },
  })

  assert.equal(response.statusCode, 201)
  // Two distinct rows now — (userA, shared-token) and (userB, shared-token).
  assert.equal(rows.length, 2)
  assert.ok(rows.some((r) => r.userId === userA && r.platform === 'ios'))
  assert.ok(rows.some((r) => r.userId === userB && r.platform === 'android'))
  await app.close()
})
