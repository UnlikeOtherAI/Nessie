import assert from 'node:assert/strict'
import test from 'node:test'

import { registerAuditLogRoutes } from '../src/routes/audit-log.js'
import { csvCell } from '../src/services/audit-export.js'
import { IDS, actorContext, localOwner, makeApp, seedTenants } from './conformance/harness.js'
import { TenantStore } from './conformance/tenant-store.js'

/**
 * Admin › Security's Export and Verify integrity.
 *
 * The export is every entry the list's filters match, for the caller's own
 * organisation only, as CSV a spreadsheet opens without running anything a
 * person typed; taking it is itself recorded. Verify says how many entries it
 * could not check, so "all N verified" is never a claim about entries written
 * before the hash chain existed.
 */

const entry = (overrides: Record<string, unknown>) => ({
  actorId: IDS.userA,
  actorType: 'user',
  action: 'agent.created',
  channelId: null,
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  entryHash: 'hash',
  ipAddress: null,
  metadata: null,
  organizationId: IDS.orgA,
  outcome: 'success',
  prevHash: null,
  projectId: null,
  reason: null,
  requestId: 'r1',
  resourceId: IDS.agentA,
  resourceType: 'agent',
  teamId: null,
  userAgent: null,
  ...overrides,
})

const seed = (store: TenantStore) => {
  seedTenants(store)
  store.seed('auditLog', [
    entry({ id: '10000000-0000-4000-8000-000000000001' }),
    entry({
      action: 'channel.deleted',
      id: '10000000-0000-4000-8000-000000000002',
      outcome: 'denied',
      reason: '=HYPERLINK("https://evil.test","click")',
    }),
    // Written before the chain existed: listed and exported, never verified.
    entry({ entryHash: null, id: '10000000-0000-4000-8000-000000000003' }),
    // Another organisation's entry, which no filter may ever reach.
    entry({ id: '10000000-0000-4000-8000-000000000004', organizationId: IDS.orgB }),
  ])
}

const csvLines = (body: string) => body.split('\r\n').filter((line) => line.length > 0)

test('the export is the caller organisation’s trail as CSV, with a header row', async () => {
  const store = new TenantStore()
  seed(store)
  const app = makeApp(registerAuditLogRoutes, store, localOwner())

  const res = await app.inject({ method: 'GET', url: '/api/audit-log/export' })
  assert.equal(res.statusCode, 200)
  assert.match(String(res.headers['content-type']), /^text\/csv; charset=utf-8/)
  assert.match(String(res.headers['content-disposition']), /^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/)
  assert.equal(res.headers['cache-control'], 'no-store')

  const [header, ...rows] = csvLines(res.body)
  assert.equal(
    header,
    'created_at,actor_type,actor_id,action,outcome,reason,resource_type,resource_id,'
      + 'team_id,project_id,channel_id,request_id,ip_address,user_agent,metadata,entry_id',
  )
  const ids = rows.map((row) => row.split(',').at(-1))
  // The export's own record is written before the file streams, so it is in
  // the file too — the trail says who took it, including to whoever reads it.
  assert.ok(ids.includes('10000000-0000-4000-8000-000000000001'))
  assert.ok(ids.includes('10000000-0000-4000-8000-000000000003'))
  assert.equal(ids.includes('10000000-0000-4000-8000-000000000004'), false)
  await app.close()
})

test('the export applies the list’s filters', async () => {
  const store = new TenantStore()
  seed(store)
  const app = makeApp(registerAuditLogRoutes, store, localOwner())

  const res = await app.inject({ method: 'GET', url: '/api/audit-log/export?outcome=denied' })
  assert.equal(res.statusCode, 200)
  const [, ...rows] = csvLines(res.body)
  assert.equal(rows.length, 1)
  assert.match(rows[0] ?? '', /,channel\.deleted,denied,/)
  await app.close()
})

test('a cell a spreadsheet would run is written as text', async () => {
  const store = new TenantStore()
  seed(store)
  const app = makeApp(registerAuditLogRoutes, store, localOwner())

  const res = await app.inject({ method: 'GET', url: '/api/audit-log/export?outcome=denied' })
  assert.ok(res.body.includes('"\'=HYPERLINK(""https://evil.test"",""click"")"'))
  await app.close()
})

test('taking an export is recorded, with the filters it was taken with', async () => {
  const store = new TenantStore()
  seed(store)
  const app = makeApp(registerAuditLogRoutes, store, localOwner())

  await app.inject({ method: 'GET', url: '/api/audit-log/export?outcome=denied&action=channel.deleted' })
  const client = store.client as unknown as {
    auditLog: { findMany: (args: unknown) => Promise<Array<Record<string, unknown>>> }
  }
  const exported = await client.auditLog.findMany({ where: { action: 'audit.exported' } })
  assert.equal(exported.length, 1)
  assert.equal(exported[0]?.organizationId, IDS.orgA)
  assert.deepEqual(exported[0]?.metadata, {
    filters: { action: 'channel.deleted', outcome: 'denied' },
  })
  await app.close()
})

test('only an owner may export the trail', async () => {
  const store = new TenantStore()
  seed(store)
  const admin = actorContext({
    organizationId: IDS.orgA,
    projectId: IDS.projectA,
    roles: ['admin'],
    teamId: IDS.teamA,
    userId: IDS.userA,
  })
  const app = makeApp(registerAuditLogRoutes, store, admin)

  const res = await app.inject({ method: 'GET', url: '/api/audit-log/export' })
  assert.equal(res.statusCode, 403)
  await app.close()
})

test('an unreadable date is the caller’s error, not a 500', async () => {
  const store = new TenantStore()
  seed(store)
  const app = makeApp(registerAuditLogRoutes, store, localOwner())

  const res = await app.inject({ method: 'GET', url: '/api/audit-log/export?from=banana' })
  assert.equal(res.statusCode, 400)
  await app.close()
})

test('verify counts the entries it could not check, in the caller’s organisation only', async () => {
  const store = new TenantStore()
  seed(store)
  store.seed('auditLog', [
    entry({ entryHash: null, id: '10000000-0000-4000-8000-000000000005', organizationId: IDS.orgB }),
  ])
  const app = makeApp(registerAuditLogRoutes, store, localOwner())

  const res = await app.inject({ method: 'GET', url: '/api/audit-log/verify' })
  assert.equal(res.statusCode, 200)
  const body = res.json() as { data: { unchainedCount: number } }
  assert.equal(body.data.unchainedCount, 1)
  await app.close()
})

test('a CSV cell is quoted only when it has to be', () => {
  assert.equal(csvCell(null), '')
  assert.equal(csvCell(undefined), '')
  assert.equal(csvCell('plain'), 'plain')
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell('say "hi"'), '"say ""hi"""')
  assert.equal(csvCell('two\nlines'), '"two\nlines"')
  assert.equal(csvCell({ key: 'value' }), '"{""key"":""value""}"')
  assert.equal(csvCell('-1'), "'-1")
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)")
})
