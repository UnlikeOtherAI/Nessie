import assert from 'node:assert/strict'
import test from 'node:test'
import { ExecutorRecordResponseSchema } from '@nessie/schemas'
import { patchExecutorStatus } from '../src/facades/executors/realtime'
import { executorGroupStatus } from '../src/facades/executors/status'
import { unionActivityScopes } from '../src/facades/agents/activity-socket'

test('executor menu status distinguishes empty, all online, mixed, and all unavailable', () => {
  assert.equal(executorGroupStatus([]).token, '--tx3')
  assert.equal(executorGroupStatus([{ status: 'online' }]).token, '--success')
  assert.equal(executorGroupStatus([{ status: 'online' }, { status: 'paused' }]).token, '--warning')
  assert.equal(executorGroupStatus([{ status: 'offline' }, { status: 'revoked' }]).token, '--danger')
})

test('delayed presence cannot overwrite a newer heartbeat and null fields are cleared', () => {
  const record = ExecutorRecordResponseSchema.parse({
    id: '33333333-3333-4333-8333-333333333333', label: 'Machine', profiles: [], authorizationRevision: 1,
    scope: { kind: 'private', organizationId: '22222222-2222-4222-8222-222222222222' },
    status: 'online', createdAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:02:00.000Z',
    statusDetail: 'previous error', lastSeenAt: '2026-09-24T00:02:00.000Z',
  })
  const update = { executorId: record.id, updatedAt: '2026-09-24T00:01:00.000Z',
    status: 'offline' as const, lastSeenAt: null, statusDetail: null, removed: false }
  assert.equal(patchExecutorStatus(record, update), record)
  const patched = patchExecutorStatus(record, { ...update, updatedAt: '2026-09-24T00:03:00.000Z' })
  assert.equal(patched.status, 'offline')
  assert.equal(patched.statusDetail, undefined)
  assert.equal(patched.lastSeenAt, undefined)
})

test('inventory shares the activity socket scope union without duplicate subscriptions', () => {
  const scope = { channelIds: [], dashboardIds: [], organizationId: 'org', executorInventory: true }
  assert.deepEqual(unionActivityScopes([scope, scope]), [
    { kind: 'executor_inventory', organizationId: 'org' }, { kind: 'organization', organizationId: 'org' },
  ])
})
