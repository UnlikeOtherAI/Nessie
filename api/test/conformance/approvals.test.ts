import assert from 'node:assert/strict'
import test from 'node:test'

import { registerApprovalRoutes } from '../../src/routes/approvals.js'
import { IDS, foreignOwner, makeApp, seedTenants } from './harness.js'
import { TenantStore } from './tenant-store.js'

const seedApproval = (store: TenantStore) => {
  seedTenants(store)
  return store.seed('approvalRequest', [
    {
      id: IDS.approvalA,
      organizationId: IDS.orgA,
      projectId: IDS.projectA,
      teamId: IDS.teamA,
      channelId: IDS.channelA,
      taskId: null,
      runId: null,
      agentId: IDS.agentA,
      requesterId: IDS.userA,
      action: 'agent.invoke',
      reason: 'needs approval',
      context: null,
      requiredApproverRole: null,
      continuationToken: 'tok',
      status: 'pending',
      resolvedById: null,
      resolvedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    },
  ])
}

test('GET /api/approvals never lists another org\'s approvals', async () => {
  const store = new TenantStore()
  seedApproval(store)
  const app = makeApp(registerApprovalRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'GET', url: '/api/approvals' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual((res.json() as { data: unknown[] }).data, [])
  await app.close()
})

test('GET /api/approvals/:id 404s on another org\'s approval', async () => {
  const store = new TenantStore()
  seedApproval(store)
  const app = makeApp(registerApprovalRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'GET', url: `/api/approvals/${IDS.approvalA}` })
  assert.equal(res.statusCode, 404)
  await app.close()
})

test('POST /api/approvals/:id/resolve rejects resolving another org\'s approval', async () => {
  const store = new TenantStore()
  const rows = seedApproval(store)
  const app = makeApp(registerApprovalRoutes, store, foreignOwner())

  const res = await app.inject({
    method: 'POST',
    url: `/api/approvals/${IDS.approvalA}/resolve`,
    payload: { resolution: 'approved' },
  })
  assert.equal(res.statusCode, 404)
  // The orgA approval stays pending — a foreign owner could not resolve it.
  assert.equal(rows[0]?.['status'], 'pending')
  await app.close()
})
