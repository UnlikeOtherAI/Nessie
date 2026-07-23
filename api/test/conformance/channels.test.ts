import assert from 'node:assert/strict'
import test from 'node:test'

import { registerChannelRoutes } from '../../src/routes/channels.js'
import { IDS, foreignOwner, makeApp, seedTenants } from './harness.js'
import { TenantStore } from './tenant-store.js'

const seedChannel = (store: TenantStore) => {
  seedTenants(store)
  return store.seed('channel', [
    {
      id: IDS.channelA,
      organizationId: IDS.orgA,
      projectId: IDS.projectA,
      teamId: IDS.teamA,
      label: 'orgA-general',
      slug: 'orga-general',
      visibility: 'public',
      type: 'standard',
      systemChannelType: null,
      archivedAt: null,
      topic: null,
      description: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    },
  ])
}

test('GET /api/channels never returns another org\'s channels', async () => {
  const store = new TenantStore()
  seedChannel(store)
  const app = makeApp(registerChannelRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'GET', url: '/api/channels' })
  assert.equal(res.statusCode, 200)
  const body = res.json() as { data: Array<{ id: string }> }
  assert.deepEqual(body.data, [])
  await app.close()
})

test('PATCH /api/channels/:id rejects updating another org\'s channel', async () => {
  const store = new TenantStore()
  const rows = seedChannel(store)
  const app = makeApp(registerChannelRoutes, store, foreignOwner())

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/channels/${IDS.channelA}`,
    payload: { topic: 'hijacked' },
  })
  assert.equal(res.statusCode, 403)
  // The orgA row must be byte-for-byte untouched.
  assert.equal(rows[0]?.['topic'], null)
  await app.close()
})

test('POST /api/channels/:id/archive rejects archiving another org\'s channel', async () => {
  const store = new TenantStore()
  const rows = seedChannel(store)
  const app = makeApp(registerChannelRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'POST', url: `/api/channels/${IDS.channelA}/archive` })
  assert.equal(res.statusCode, 403)
  assert.equal(rows[0]?.['archivedAt'], null)
  await app.close()
})
