import assert from 'node:assert/strict'
import test from 'node:test'

import { registerAuditLogRoutes } from '../../src/routes/audit-log.js'
import { IDS, foreignOwner, localOwner, makeApp, seedTenants } from './harness.js'
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

// A mistyped date filter used to reach node-postgres as an Invalid Date and
// answer 500 on the compliance surface; both endpoints now reject it as the
// caller's error.
test('GET /api/audit-log?from=banana answers 400, not 500', async () => {
  const store = new TenantStore()
  seedAudit(store)
  const app = makeApp(registerAuditLogRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'GET', url: '/api/audit-log?from=banana' })
  assert.equal(res.statusCode, 400)
  assert.equal((res.json() as { error: { code: string } }).error.code, 'VALIDATION_ERROR')
  await app.close()
})

test('GET /api/audit-log/summary?to=banana answers 400, not 500', async () => {
  const store = new TenantStore()
  seedAudit(store)
  const app = makeApp(registerAuditLogRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'GET', url: '/api/audit-log/summary?to=banana' })
  assert.equal(res.statusCode, 400)
  assert.equal((res.json() as { error: { code: string } }).error.code, 'VALIDATION_ERROR')
  await app.close()
})

test('GET /api/audit-log/summary?groupBy= outside the whitelist answers 400', async () => {
  const store = new TenantStore()
  seedAudit(store)
  const app = makeApp(registerAuditLogRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'GET', url: '/api/audit-log/summary?groupBy=metadata' })
  assert.equal(res.statusCode, 400)
  assert.equal((res.json() as { error: { code: string } }).error.code, 'VALIDATION_ERROR')
  await app.close()
})

// The positive control for the coercion: everything `new Date` accepted before
// must still parse, and a valid filter still reaches the query.
test('GET /api/audit-log with a valid date filter still answers 200', async () => {
  const store = new TenantStore()
  seedAudit(store)
  const app = makeApp(registerAuditLogRoutes, store, localOwner())

  const res = await app.inject({
    method: 'GET',
    url: '/api/audit-log?from=2026-06-01&to=2026-08-01T00:00:00.000Z',
  })
  assert.equal(res.statusCode, 200)
  await app.close()
})
