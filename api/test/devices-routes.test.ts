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
  apnsEnvironment: 'sandbox' | 'production' | null
  registrationVersion: bigint
  inactiveAt: Date | null
  lastSeenAt: Date
  createdAt: Date
}

const actorContextFor = (
  userId: string,
  activeOrganizationId = organizationId,
  pushRegistrationVersion = '0',
): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles: ['member'] },
  tenant: { organizationId: activeOrganizationId, projectId },
  actionContext: { requestId: `req-devices-${userId}`, pushRegistrationVersion },
})

/**
 * In-memory `deviceToken` store reproducing the ordered physical-token write
 * and scoped tombstoning the route relies on. Shared across the app so we can
 * assert idempotent registration and ownership transfer behaviour.
 */
const makeApp = (
  userId: string,
  rows: DeviceRow[] = [],
  activeOrganizationId = organizationId,
  pushRegistrationVersion = '0',
) => {
  let registrationGeneration = BigInt(pushRegistrationVersion)
  const prisma = {
    deviceToken: {
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          token: string
          registrationVersion?: { lte: bigint }
          organizationId?: string
          userId?: string
        }
        data: {
          organizationId?: string
          userId?: string
          platform?: string
          appVersion?: string | null
          registrationVersion: bigint
          inactiveAt?: Date | null
          apnsEnvironment?: 'sandbox' | 'production' | null
          lastSeenAt?: Date
        }
      }) => {
        const existing = rows.find((row) => row.token === where.token)
        if (!existing) return { count: 0 }
        if (
          where.registrationVersion
          && existing.registrationVersion > where.registrationVersion.lte
        ) return { count: 0 }
        if (where.organizationId && existing.organizationId !== where.organizationId) return { count: 0 }
        if (where.userId && existing.userId !== where.userId) return { count: 0 }
        existing.organizationId = data.organizationId ?? existing.organizationId
        existing.userId = data.userId ?? existing.userId
        existing.platform = data.platform ?? existing.platform
        existing.appVersion = data.appVersion ?? existing.appVersion
        existing.registrationVersion = data.registrationVersion
        existing.inactiveAt = data.inactiveAt === undefined ? existing.inactiveAt : data.inactiveAt
        existing.apnsEnvironment = data.apnsEnvironment === undefined
          ? existing.apnsEnvironment
          : data.apnsEnvironment
        existing.lastSeenAt = data.lastSeenAt ?? existing.lastSeenAt
        return { count: 1 }
      },
      findUnique: async ({ where }: { where: { token: string } }) =>
        rows.find((row) => row.token === where.token) ?? null,
      create: async ({
        data: create,
      }: {
        data: Omit<DeviceRow, 'id' | 'lastSeenAt' | 'createdAt'> & { appVersion?: string }
      }) => {
        const now = new Date()
        const created: DeviceRow = {
          id: randomUUID(),
          organizationId: create.organizationId,
          userId: create.userId,
          platform: create.platform,
          token: create.token,
          appVersion: create.appVersion ?? null,
          registrationVersion: create.registrationVersion,
          inactiveAt: create.inactiveAt ?? null,
          apnsEnvironment: create.apnsEnvironment ?? null,
          lastSeenAt: now,
          createdAt: now,
        }
        rows.push(created)
        return created
      },
    },
    pushRegistrationGeneration: {
      upsert: async () => {
        registrationGeneration += 1n
        return { value: registrationGeneration }
      },
    },
  } as unknown as PrismaClient

  const app = Fastify({ logger: false })
  registerDeviceRoutes(app, {
    prisma,
    requireActorContext: () => actorContextFor(userId, activeOrganizationId, pushRegistrationVersion),
  } as unknown as Parameters<typeof registerDeviceRoutes>[1])
  return { app, rows }
}

test('POST /api/devices registers a new native device token for the caller', async () => {
  const { app, rows } = makeApp(userA)
  const response = await app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: {
      platform: 'ios',
      token: 'apns-token-1',
      appVersion: '1.2.3',
      apnsEnvironment: 'sandbox',
    },
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
  assert.equal(rows[0]?.apnsEnvironment, 'sandbox')
  // The response must not leak tenant internals.
  assert.equal('organizationId' in payload.data, false)
  assert.equal('userId' in payload.data, false)
  await app.close()
})

test('POST /api/devices upserts one physical token with no duplicate row', async () => {
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
  assert.equal(rows.length, 1)
  assert.ok(rows[0]?.inactiveAt instanceof Date)

  // Repeating the deletion leaves the non-deliverable tombstone in place.
  const second = await app.inject({ method: 'DELETE', url: '/api/devices/apns-token-1' })
  assert.equal(second.statusCode, 204)
  assert.equal(rows.length, 1)
  assert.ok(rows[0]?.inactiveAt instanceof Date)
  await app.close()
})

test('a delayed registration cannot reactivate a logout tombstone', async () => {
  const rows: DeviceRow[] = [
    {
      id: randomUUID(),
      organizationId,
      userId: userA,
      platform: 'ios',
      token: 'logout-tombstone-token',
      appVersion: null,
      apnsEnvironment: 'sandbox',
      registrationVersion: 1n,
      inactiveAt: null,
      lastSeenAt: new Date(),
      createdAt: new Date(),
    },
  ]
  const current = makeApp(userA, rows, organizationId, '1')
  const delayed = makeApp(userA, rows, organizationId, '1')

  const logout = await current.app.inject({
    method: 'DELETE',
    url: '/api/devices/logout-tombstone-token',
  })
  const late = await delayed.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'logout-tombstone-token' },
  })

  assert.equal(logout.statusCode, 204)
  assert.equal(late.statusCode, 201)
  assert.ok(rows[0]?.inactiveAt instanceof Date)
  assert.equal(rows[0]?.registrationVersion, 2n)
  await current.app.close()
  await delayed.app.close()
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
      apnsEnvironment: null,
      registrationVersion: 0n,
      inactiveAt: null,
      lastSeenAt: new Date(),
      createdAt: new Date(),
    },
  ]
  const { app } = makeApp(userB, rows, organizationId, '1')

  const response = await app.inject({ method: 'DELETE', url: '/api/devices/apns-token-shared' })
  assert.equal(response.statusCode, 204)
  // userA's row is untouched — the scoped deleteMany matched nothing for userB.
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.userId, userA)
  await app.close()
})

test('a user re-registering an existing token transfers it from the former user', async () => {
  // userA already owns "shared-token". userB registers the same token string.
  const rows: DeviceRow[] = [
    {
      id: randomUUID(),
      organizationId,
      userId: userA,
      platform: 'ios',
      token: 'shared-token',
      appVersion: null,
      apnsEnvironment: null,
      registrationVersion: 0n,
      inactiveAt: null,
      lastSeenAt: new Date(),
      createdAt: new Date(),
    },
  ]
  const { app } = makeApp(userB, rows, organizationId, '1')

  const response = await app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'android', token: 'shared-token' },
  })

  assert.equal(response.statusCode, 201)
  // One physical installation must never fan private previews to both people.
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.userId, userB)
  assert.equal(rows[0]?.platform, 'android')
  await app.close()
})

test('a late former-account registration cannot reclaim a token after an ownership transfer', async () => {
  const rows: DeviceRow[] = [
    {
      id: randomUUID(),
      organizationId,
      userId: userA,
      platform: 'ios',
      token: 'ordered-token',
      appVersion: null,
      apnsEnvironment: 'sandbox',
      registrationVersion: 0n,
      inactiveAt: null,
      lastSeenAt: new Date(),
      createdAt: new Date(),
    },
  ]
  const former = makeApp(userA, rows, organizationId, '1')
  const currentOrganizationId = '00000000-0000-4000-8000-000000000099'
  const current = makeApp(userB, rows, currentOrganizationId, '2')

  await current.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'ordered-token' },
  })
  const late = await former.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'ordered-token' },
  })

  assert.equal(late.statusCode, 201)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.userId, userB)
  assert.equal(rows[0]?.organizationId, currentOrganizationId)
  await former.app.close()
  await current.app.close()
})

test('registering in another organization transfers the device to that active workspace', async () => {
  const otherOrganizationId = '00000000-0000-4000-8000-000000000099'
  const rows: DeviceRow[] = []
  const first = makeApp(userA, rows, organizationId, '1')
  const second = makeApp(userA, rows, otherOrganizationId, '2')

  await first.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'shared-device-token' },
  })
  await second.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'shared-device-token' },
  })

  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.organizationId, otherOrganizationId)
  await first.app.close()
  await second.app.close()
})
