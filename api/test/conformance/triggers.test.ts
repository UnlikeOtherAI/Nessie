import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTriggerRoutes } from '../../src/routes/triggers.js'
import { IDS, foreignOwner, makeApp, seedTenants } from './harness.js'
import { TenantStore } from './tenant-store.js'

const seedTrigger = (store: TenantStore) => {
  seedTenants(store)
  store.seed('agent', [
    {
      id: IDS.agentA,
      organizationId: IDS.orgA,
      agentKind: 'shared',
      systemManaged: false,
    },
  ])
  return store.seed('agentTrigger', [
    {
      id: IDS.triggerA,
      organizationId: IDS.orgA,
      agentId: IDS.agentA,
      workflowInstallationId: null,
      type: 'scheduled',
      name: 'orgA nightly',
      description: null,
      enabled: true,
      status: 'active',
      config: {},
      targetChannelId: null,
      targetThreadId: null,
      lastFiredAt: null,
      nextRunAt: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    },
  ])
}

test('GET /api/triggers never lists another org\'s triggers', async () => {
  const store = new TenantStore()
  seedTrigger(store)
  const app = makeApp(registerTriggerRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'GET', url: '/api/triggers' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual((res.json() as { data: unknown[] }).data, [])
  await app.close()
})

test('DELETE /api/triggers/:id rejects deleting another org\'s trigger', async () => {
  const store = new TenantStore()
  const rows = seedTrigger(store)
  const app = makeApp(registerTriggerRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'DELETE', url: `/api/triggers/${IDS.triggerA}` })
  // 404 (never 204): the trigger is invisible to a foreign owner and survives.
  assert.equal(res.statusCode, 404)
  assert.equal(rows.length, 1)
  await app.close()
})

test('POST /api/triggers/:id/pause rejects pausing another org\'s trigger', async () => {
  const store = new TenantStore()
  const rows = seedTrigger(store)
  const app = makeApp(registerTriggerRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'POST', url: `/api/triggers/${IDS.triggerA}/pause` })
  assert.equal(res.statusCode, 404)
  assert.equal(rows[0]?.['status'], 'active')
  await app.close()
})
