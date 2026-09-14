import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  makeApp,
  organizationId,
  type DeviceRow,
  userA,
  userB,
} from './device-token-routes-harness.js'

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

test('a new account can revive its physical installation after logout only with its proof', async () => {
  const rows: DeviceRow[] = []
  const former = makeApp(userA, rows, organizationId, '1')
  const first = await former.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'tombstone-transfer-token' },
  })
  const ownershipProof = (first.json() as { data: { ownershipProof?: string } }).data.ownershipProof
  await former.app.inject({ method: 'DELETE', url: '/api/devices/tombstone-transfer-token' })

  const newOrganizationId = '00000000-0000-4000-8000-000000000099'
  const current = makeApp(userB, rows, newOrganizationId, '3')
  const restored = await current.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'tombstone-transfer-token', ownershipProof },
  })

  assert.equal(restored.statusCode, 201)
  assert.equal(rows[0]?.inactiveAt, null)
  assert.equal(rows[0]?.userId, userB)
  assert.equal(rows[0]?.organizationId, newOrganizationId)
  await former.app.close()
  await current.app.close()
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

test('a copied native token cannot transfer another person\'s installation', async () => {
  const rows: DeviceRow[] = []
  const former = makeApp(userA, rows, organizationId, '1')
  const first = await former.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'shared-token' },
  })
  assert.equal(first.statusCode, 201)
  const { app } = makeApp(userB, rows, organizationId, '1')

  const response = await app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'android', token: 'shared-token' },
  })

  assert.equal(response.statusCode, 403)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.userId, userA)
  assert.equal(rows[0]?.platform, 'ios')
  await former.app.close()
  await app.close()
})

test('an installation proof transfers an account switch and rotates before a former session arrives', async () => {
  const rows: DeviceRow[] = []
  const former = makeApp(userA, rows, organizationId, '1')
  const currentOrganizationId = '00000000-0000-4000-8000-000000000099'
  const current = makeApp(userB, rows, currentOrganizationId, '2')

  const initial = await former.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'ordered-token' },
  })
  const initialProof = (initial.json() as { data: { ownershipProof?: string } }).data.ownershipProof
  assert.equal(typeof initialProof, 'string')

  const transferred = await current.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'ordered-token', ownershipProof: initialProof },
  })
  assert.equal(transferred.statusCode, 201)
  const transferredProof = (transferred.json() as { data: { ownershipProof?: string } }).data.ownershipProof
  assert.equal(typeof transferredProof, 'string')
  assert.notEqual(transferredProof, initialProof)
  const late = await former.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'ordered-token', ownershipProof: initialProof },
  })

  assert.equal(late.statusCode, 201)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.userId, userB)
  assert.equal(rows[0]?.organizationId, currentOrganizationId)
  await former.app.close()
  await current.app.close()
})

test('a stale former session cannot revive a tombstone after a proofed transfer', async () => {
  const rows: DeviceRow[] = []
  const former = makeApp(userA, rows, organizationId, '1')
  const currentOrganizationId = '00000000-0000-4000-8000-000000000099'
  const current = makeApp(userB, rows, currentOrganizationId, '2')
  const nextOrganizationId = '00000000-0000-4000-8000-000000000088'
  const next = makeApp(userA, rows, nextOrganizationId, '4')

  const initial = await former.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'transferred-tombstone-token' },
  })
  const initialProof = (initial.json() as { data: { ownershipProof?: string } }).data.ownershipProof
  assert.equal(typeof initialProof, 'string')
  const transferred = await current.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'transferred-tombstone-token', ownershipProof: initialProof },
  })
  const transferredProof = (transferred.json() as { data: { ownershipProof?: string } }).data.ownershipProof
  assert.equal(typeof transferredProof, 'string')
  assert.notEqual(transferredProof, initialProof)

  const deleted = await current.app.inject({ method: 'DELETE', url: '/api/devices/transferred-tombstone-token' })
  assert.equal(deleted.statusCode, 204)
  const stale = await former.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'transferred-tombstone-token', ownershipProof: initialProof },
  })
  assert.equal(stale.statusCode, 201)
  assert.ok(rows[0]?.inactiveAt instanceof Date)

  const revived = await next.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'transferred-tombstone-token', ownershipProof: transferredProof },
  })
  assert.equal(revived.statusCode, 201)
  const revivedProof = (revived.json() as { data: { ownershipProof?: string } }).data.ownershipProof
  assert.equal(typeof revivedProof, 'string')
  assert.notEqual(revivedProof, transferredProof)
  assert.equal(rows[0]?.inactiveAt, null)
  assert.equal(rows[0]?.organizationId, nextOrganizationId)
  await former.app.close()
  await current.app.close()
  await next.app.close()
})

test('registering in another organization transfers the device to that active team', async () => {
  const otherOrganizationId = '00000000-0000-4000-8000-000000000099'
  const rows: DeviceRow[] = []
  const first = makeApp(userA, rows, organizationId, '1')
  const second = makeApp(userA, rows, otherOrganizationId, '2')

  const firstRegistration = await first.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'shared-device-token' },
  })
  const ownershipProof = (firstRegistration.json() as { data: { ownershipProof?: string } }).data.ownershipProof
  await second.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'shared-device-token', ownershipProof },
  })

  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.organizationId, otherOrganizationId)
  await first.app.close()
  await second.app.close()
})
