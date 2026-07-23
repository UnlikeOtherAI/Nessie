import assert from 'node:assert/strict'
import test from 'node:test'

import { registerRunRoutes } from '../../src/routes/runs.js'
import { IDS, foreignOwner, makeApp, seedTenants } from './harness.js'
import { TenantStore } from './tenant-store.js'

const RUN_A = '00000000-0000-4000-8000-0000000000d0'

// Seed a run under orgA, reachable only through thread → channel →
// organizationId — exactly the chain `loadRunForOrg` narrows by.
const seedRun = (store: TenantStore) => {
  seedTenants(store)
  store.seed('channel', [{ id: IDS.channelA, organizationId: IDS.orgA }])
  store.seed('thread', [{ id: IDS.threadA, channelId: IDS.channelA }])
  return store.seed('run', [
    {
      id: RUN_A,
      agentId: IDS.agentA,
      threadId: IDS.threadA,
      status: 'running',
      cancelRequestedAt: null,
      cancelRequestedByUserId: null,
      triggerMessageId: null,
      restartOfRunId: null,
    },
  ])
}

test('GET /api/runs/active never lists another org\'s runs', async () => {
  const store = new TenantStore()
  seedRun(store)
  const app = makeApp(registerRunRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'GET', url: '/api/runs/active' })
  assert.equal(res.statusCode, 200)
  const body = res.json() as { data: { runs: unknown[]; restartable: unknown[] } }
  assert.deepEqual(body.data.runs, [])
  assert.deepEqual(body.data.restartable, [])
  await app.close()
})

test('POST /api/runs/:id/cancel 404s on another org\'s run and leaves it running', async () => {
  const store = new TenantStore()
  const rows = seedRun(store)
  const app = makeApp(registerRunRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'POST', url: `/api/runs/${RUN_A}/cancel` })
  assert.equal(res.statusCode, 404)
  assert.equal(rows[0]?.['status'], 'running')
  assert.equal(rows[0]?.['cancelRequestedAt'], null)
  await app.close()
})

test('POST /api/runs/:id/restart 404s on another org\'s run', async () => {
  const store = new TenantStore()
  seedRun(store)
  const app = makeApp(registerRunRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'POST', url: `/api/runs/${RUN_A}/restart` })
  assert.equal(res.statusCode, 404)
  await app.close()
})
