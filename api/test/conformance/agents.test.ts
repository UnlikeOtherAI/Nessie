import assert from 'node:assert/strict'
import test from 'node:test'

import { registerAgentRoutes } from '../../src/routes/agents.js'
import { IDS, foreignOwner, makeApp, seedTenants } from './harness.js'
import { TenantStore } from './tenant-store.js'

const seedAgent = (store: TenantStore) => {
  seedTenants(store)
  store.seed('channel', [
    {
      id: IDS.channelA,
      organizationId: IDS.orgA,
      teamId: IDS.teamA,
      projectId: IDS.projectA,
      visibility: 'public',
      type: 'standard',
      systemChannelType: null,
    },
  ])
  return store.seed('agent', [
    {
      id: IDS.agentA,
      organizationId: IDS.orgA,
      agentKind: 'shared',
      systemManaged: false,
      name: 'orgA agent',
      role: 'assistant',
      status: 'idle',
    },
  ])
}

test('GET /api/agents never lists another org\'s agents', async () => {
  const store = new TenantStore()
  seedAgent(store)
  const app = makeApp(registerAgentRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'GET', url: '/api/agents' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual((res.json() as { data: unknown[] }).data, [])
  await app.close()
})

test('PUT /api/agents/:id rejects updating another org\'s agent', async () => {
  const store = new TenantStore()
  const rows = seedAgent(store)
  const app = makeApp(registerAgentRoutes, store, foreignOwner())

  const res = await app.inject({
    method: 'PUT',
    url: `/api/agents/${IDS.agentA}`,
    payload: { name: 'hijacked' },
  })
  assert.equal(res.statusCode, 404)
  assert.equal(rows[0]?.['name'], 'orgA agent')
  await app.close()
})

test('POST /api/agents/:id/bindings rejects binding to another org\'s channel', async () => {
  const store = new TenantStore()
  seedAgent(store)
  const app = makeApp(registerAgentRoutes, store, foreignOwner())

  const res = await app.inject({
    method: 'POST',
    url: `/api/agents/${IDS.agentA}/bindings`,
    payload: { channelId: IDS.channelA },
  })
  // The orgA channel is invisible to orgB, so the bind never reaches policy.
  assert.equal(res.statusCode, 404)
  assert.equal(store.rows('agentBinding').length, 0)
  await app.close()
})

test('GET /api/agents/:id/status 404s on another org\'s agent', async () => {
  const store = new TenantStore()
  seedAgent(store)
  const app = makeApp(registerAgentRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'GET', url: `/api/agents/${IDS.agentA}/status` })
  assert.equal(res.statusCode, 404)
  await app.close()
})
