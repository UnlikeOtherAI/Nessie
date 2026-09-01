import assert from 'node:assert/strict'
import test from 'node:test'

import { registerAuditLogRoutes } from '../../src/routes/audit-log.js'
import { IDS, foreignOwner, makeApp, seedTenants } from './harness.js'
import { TenantStore } from './tenant-store.js'

const seedAudit = (store: TenantStore) => {
  seedTenants(store)
  // An orgA audit entry — with a deliberately *broken* chain link — that must
  // remain invisible and unverifiable to orgB.
  return store.seed('auditLog', [
    {
      id: IDS.auditA,
      organizationId: IDS.orgA,
      projectId: null,
      teamId: null,
      channelId: null,
      actorType: 'user',
      actorId: IDS.userA,
      action: 'agent.created',
      resourceType: 'agent',
      resourceId: IDS.agentA,
      outcome: 'success',
      reason: null,
      metadata: null,
      requestId: 'r1',
      ipAddress: null,
      userAgent: null,
      entryHash: 'deadbeef',
      prevHash: 'not-the-genesis-hash',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    },
  ])
}

test('GET /api/audit-log never lists another org\'s entries', async () => {
  const store = new TenantStore()
  seedAudit(store)
  const app = makeApp(registerAuditLogRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'GET', url: '/api/audit-log' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual((res.json() as { data: unknown[] }).data, [])
  await app.close()
})

test('GET /api/audit-log/:id 404s on another org\'s entry', async () => {
  const store = new TenantStore()
  seedAudit(store)
  const app = makeApp(registerAuditLogRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'GET', url: `/api/audit-log/${IDS.auditA}` })
  assert.equal(res.statusCode, 404)
  await app.close()
})

test('GET /api/audit-log/verify only walks the caller\'s own chain', async () => {
  const store = new TenantStore()
  seedAudit(store)
  const app = makeApp(registerAuditLogRoutes, store, foreignOwner())

  // orgB has no audit entries: verification is trivially valid and scans zero
  // rows. Critically it does NOT touch — or leak the tamper state of — orgA's
  // poisoned chain.
  const res = await app.inject({ method: 'GET', url: '/api/audit-log/verify' })
  assert.equal(res.statusCode, 200)
  const body = res.json() as { data: { valid: boolean; checkedCount: number } }
  assert.equal(body.data.valid, true)
  assert.equal(body.data.checkedCount, 0)
  await app.close()
})
