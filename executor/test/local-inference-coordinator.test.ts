import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { LocalInferenceCoordinator } from '../src/local-inference-coordinator.js'

const fixture = async (t: test.TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-inference-coordinator-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  // This test exercises admission, not the separately tested Windows DACL helper.
  const security = process.platform === 'win32' ? { helper: async () => undefined } : {}
  const desktop = await LocalInferenceCoordinator.open({ directory, security })
  const executor = await LocalInferenceCoordinator.open({ directory, security })
  return { desktop, executor, directory, security }
}

test('Desktop and executor share one key and one slot across all models', async (t) => {
  const { desktop, executor } = await fixture(t)
  assert.deepEqual(desktop.identity, executor.identity)
  const contenders = await Promise.all([desktop.acquire(), executor.acquire()])
  assert.equal(contenders.filter(Boolean).length, 1)
  await contenders.find((slot) => slot !== null)!.releaseIdle()
  assert.ok(await executor.acquire())
})

test('pause persists across restart; unacknowledged resume never admits work', async (t) => {
  const { desktop, directory, security } = await fixture(t)
  await desktop.pause()
  const restarted = await LocalInferenceCoordinator.open({ directory, security })
  assert.equal((await restarted.control()).paused, true)
  assert.equal(await restarted.acquire(), null)
  await restarted.resume()
  assert.equal(await restarted.acquire(), null)
  await restarted.syncControl({ resourceId: randomUUID(), capacity: 1, controlRevision: 2, paused: false, healthReason: null }, 'resume')
  assert.ok(await restarted.acquire())
})

test('uncertain termination remains occupied until explicit confirmation and acknowledgement', async (t) => {
  const { desktop, executor } = await fixture(t)
  const lease = await desktop.acquire()
  assert.ok(lease)
  const identity = { admissionId: randomUUID(), attemptId: randomUUID(), fence: randomUUID(), resourceId: randomUUID() }
  await lease.bind(identity)
  await lease.finish(false)
  assert.equal(await executor.healthReason(), 'termination_uncertain')
  await executor.flushTerminations(async (termination) => { assert.equal(termination.confirmed, false) })
  assert.equal(await executor.acquire(), null)
  await executor.confirmStopped()
  await assert.rejects(executor.flushTerminations(async () => { throw new Error('offline') }), /offline/)
  assert.equal(await executor.acquire(), null)
  await executor.flushTerminations(async (termination) => {
    assert.deepEqual(termination, { ...identity, confirmed: true })
  })
  assert.ok(await executor.acquire())
})

test('confirmed completion can be acknowledged by another transport without another model call', async (t) => {
  const { desktop, executor } = await fixture(t)
  const lease = await desktop.acquire()
  assert.ok(lease)
  await lease.bind({
    admissionId: randomUUID(), attemptId: randomUUID(), fence: randomUUID(), resourceId: randomUUID(),
  })
  await lease.finish(true)
  assert.equal(await executor.acquire(), null)
  let confirmations = 0
  await executor.flushTerminations(async () => { confirmations += 1 })
  await desktop.flushTerminations(async () => { confirmations += 1 })
  assert.equal(confirmations, 1)
  assert.ok(await executor.acquire())
})

test('lowering capacity drains occupied slots rather than starting work in an empty index', async (t) => {
  const { desktop, executor } = await fixture(t)
  const resourceId = randomUUID()
  await desktop.syncControl({ resourceId, capacity: 2, controlRevision: 1, paused: false, healthReason: null })
  const first = await desktop.acquire()
  const second = await executor.acquire()
  assert.ok(first); assert.ok(second)
  await desktop.syncControl({ resourceId, capacity: 1, controlRevision: 2, paused: false, healthReason: null })
  await first.releaseIdle()
  assert.equal(await executor.acquire(), null)
  await second.releaseIdle()
  assert.ok(await desktop.acquire())
})
