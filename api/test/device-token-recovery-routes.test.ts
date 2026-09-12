import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  makeApp,
  organizationId,
  type DeviceRow,
  userA,
  userB,
} from './device-token-routes-harness.js'

test('an installed recovery key repairs a lost proof response and transfers one physical token', async () => {
  const rows: DeviceRow[] = []
  const recoveryKey = 'installed-recovery-key-that-never-left-the-webview-0123456789'
  const former = makeApp(userA, rows, organizationId, '1')
  const initial = await former.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'lost-response-token', deviceRecoveryKey: recoveryKey },
  })
  assert.equal(initial.statusCode, 201)
  const lostProof = (initial.json() as { data: { ownershipProof?: string } }).data.ownershipProof
  assert.equal(typeof lostProof, 'string')
  const attacker = makeApp(userB, rows, organizationId, '2')
  const denied = await attacker.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'lost-response-token' },
  })
  assert.equal(denied.statusCode, 403)

  const transferred = await attacker.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'lost-response-token', deviceRecoveryKey: recoveryKey },
  })
  assert.equal(transferred.statusCode, 201)
  const recoveredProof = (transferred.json() as { data: { ownershipProof?: string } }).data.ownershipProof
  assert.equal(typeof recoveredProof, 'string')
  assert.notEqual(recoveredProof, lostProof)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.userId, userB)

  const stale = await former.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'lost-response-token', deviceRecoveryKey: recoveryKey },
  })
  assert.equal(stale.statusCode, 201)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.userId, userB)
  await former.app.close()
  await attacker.app.close()
})

test('only a fresh former owner can bootstrap a legacy inactive installation', async () => {
  const rows: DeviceRow[] = [{
    id: randomUUID(),
    organizationId,
    userId: userA,
    platform: 'ios',
    token: 'legacy-tombstone-token',
    appVersion: null,
    apnsEnvironment: 'sandbox',
    registrationVersion: 3n,
    deviceRecoveryKeyHash: null,
    inactiveAt: new Date(),
    lastSeenAt: new Date(),
    createdAt: new Date(),
  }]
  const recoveryKey = 'new-key-held-by-the-legacy-installation-0123456789'
  const attacker = makeApp(userB, rows, organizationId, '4')
  const attackerResponse = await attacker.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'legacy-tombstone-token', deviceRecoveryKey: recoveryKey },
  })
  assert.equal(attackerResponse.statusCode, 403)

  const staleFormer = makeApp(userA, rows, organizationId, '2')
  const stale = await staleFormer.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'legacy-tombstone-token', deviceRecoveryKey: recoveryKey },
  })
  assert.equal(stale.statusCode, 201)
  assert.ok(rows[0]?.inactiveAt instanceof Date)

  const freshFormer = makeApp(userA, rows, organizationId, '4')
  const restored = await freshFormer.app.inject({
    method: 'POST',
    url: '/api/devices',
    payload: { platform: 'ios', token: 'legacy-tombstone-token', deviceRecoveryKey: recoveryKey },
  })
  assert.equal(restored.statusCode, 201)
  const proof = (restored.json() as { data: { ownershipProof?: string } }).data.ownershipProof
  assert.equal(typeof proof, 'string')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.inactiveAt, null)
  assert.equal(typeof rows[0]?.deviceRecoveryKeyHash, 'string')
  await attacker.app.close()
  await staleFormer.app.close()
  await freshFormer.app.close()
})
