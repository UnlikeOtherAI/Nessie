import assert from 'node:assert/strict'
import test from 'node:test'

import { registerAlertRoutes } from '../../src/routes/alerts.js'
import { foreignOwner, IDS, localOwner, makeApp, seedTenants } from './harness.js'
import { TenantStore } from './tenant-store.js'

// Tenant-isolation conformance for the user alerts API (#246). Alerts are
// private to their recipient: every read is scoped by BOTH organizationId and
// userId, so even a same-org attacker must not see another user's alerts.
const ALERT_A = '00000000-0000-4000-8000-000000000301'

const seedAlert = (store: TenantStore) =>
  {
    store.seed('channel', [{ id: IDS.channelA, organizationId: IDS.orgA }])
    store.seed('channelMember', [{ id: 'alert-channel-member-a', channelId: IDS.channelA, userId: IDS.userA }])
    return store.seed('userAlert', [
    {
      id: ALERT_A,
      organizationId: IDS.orgA,
      userId: IDS.userA,
      kind: 'mention',
      messageId: null,
      threadId: IDS.threadA,
      channelId: IDS.channelA,
      actorUserId: null,
      actorAgentId: null,
      readAt: null,
      createdAt: new Date('2026-07-24T10:00:00.000Z'),
    },
    ])
  }

test('GET /api/alerts never lists another org\'s alerts', async () => {
  const store = new TenantStore()
  seedTenants(store)
  seedAlert(store)
  const app = makeApp(registerAlertRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'GET', url: '/api/alerts' })

  assert.equal(res.statusCode, 200)
  // `data` is the page itself (the shared paged-list contract); the unread
  // count is `/api/alerts/summary`'s answer, asserted below beside it.
  const body = res.json() as { data: unknown[] }
  assert.deepEqual(body.data, [])

  const summary = await app.inject({ method: 'GET', url: '/api/alerts/summary' })
  assert.equal(summary.statusCode, 200)
  assert.equal((summary.json() as { data: { unreadCount: number } }).data.unreadCount, 0)
  await app.close()
})

test('GET /api/alerts never lists another user\'s alerts within the caller\'s org', async () => {
  const store = new TenantStore()
  seedTenants(store)
  // An alert belonging to userA but inside the ATTACKER's org (orgB): the
  // foreign owner (userB) must still not see it — scoping is per-recipient.
  store.seed('userAlert', [
    {
      id: ALERT_A,
      organizationId: IDS.orgB,
      userId: IDS.userA,
      kind: 'mention',
      messageId: null,
      threadId: null,
      channelId: null,
      actorUserId: null,
      actorAgentId: null,
      readAt: null,
      createdAt: new Date('2026-07-24T10:00:00.000Z'),
    },
  ])
  const app = makeApp(registerAlertRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'GET', url: '/api/alerts' })

  assert.equal(res.statusCode, 200)
  // `data` is the page itself (the shared paged-list contract); the unread
  // count is `/api/alerts/summary`'s answer, asserted below beside it.
  const body = res.json() as { data: unknown[] }
  assert.deepEqual(body.data, [])

  const summary = await app.inject({ method: 'GET', url: '/api/alerts/summary' })
  assert.equal(summary.statusCode, 200)
  assert.equal((summary.json() as { data: { unreadCount: number } }).data.unreadCount, 0)
  await app.close()
})

test('POST /api/alerts/read cannot mark another org\'s alert read', async () => {
  const store = new TenantStore()
  seedTenants(store)
  seedAlert(store)
  const app = makeApp(registerAlertRoutes, store, foreignOwner())

  const res = await app.inject({
    method: 'POST',
    url: '/api/alerts/read',
    payload: { ids: [ALERT_A] },
  })

  assert.equal(res.statusCode, 200)
  const body = res.json() as { data: { read: number } }
  assert.equal(body.data.read, 0)
  // The orgA row is untouched.
  assert.equal(store.rows('userAlert')[0]?.['readAt'], null)
  await app.close()
})

test('positive control: the recipient lists and marks their own alerts read', async () => {
  const store = new TenantStore()
  seedTenants(store)
  seedAlert(store)
  const app = makeApp(registerAlertRoutes, store, localOwner())

  const list = await app.inject({ method: 'GET', url: '/api/alerts' })
  assert.equal(list.statusCode, 200)
  const listBody = list.json() as { data: { id: string }[] }
  assert.deepEqual(
    listBody.data.map((alert) => alert.id),
    [ALERT_A],
  )

  const summary = await app.inject({ method: 'GET', url: '/api/alerts/summary' })
  assert.equal(summary.statusCode, 200)
  assert.equal((summary.json() as { data: { unreadCount: number } }).data.unreadCount, 1)

  const read = await app.inject({
    method: 'POST',
    url: '/api/alerts/read',
    payload: { ids: [ALERT_A] },
  })
  assert.equal(read.statusCode, 200)
  assert.equal((read.json() as { data: { read: number } }).data.read, 1)
  assert.ok(store.rows('userAlert')[0]?.['readAt'] instanceof Date)
  await app.close()
})
