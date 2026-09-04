import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  createNonOverlappingExecutorTask,
  waitForExecutorDaemonShutdown,
} from '../src/daemon.js'

test('a desktop parent-liveness pipe stops the daemon when its parent closes', async () => {
  const parentLiveness = new PassThrough()
  const stopped = waitForExecutorDaemonShutdown(parentLiveness)
  parentLiveness.end()
  await stopped
  assert.equal(parentLiveness.readableEnded, true)
})

test('client-recovery: a slow heartbeat cannot overlap its next scheduled run', async () => {
  let release: (() => void) | undefined
  let calls = 0
  const task = createNonOverlappingExecutorTask(async () => {
    calls += 1
    await new Promise<void>((resolve) => { release = resolve })
  })

  const first = task.run()
  const second = task.run()
  assert.equal(first, second)
  assert.equal(calls, 1)
  release?.()
  await first

  const third = task.run()
  assert.notEqual(third, first)
  assert.equal(calls, 2)
  release?.()
  await third
})
