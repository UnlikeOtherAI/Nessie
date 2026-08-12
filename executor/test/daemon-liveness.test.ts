import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { waitForExecutorDaemonShutdown } from '../src/daemon.js'

test('a desktop parent-liveness pipe stops the daemon when its parent closes', async () => {
  const parentLiveness = new PassThrough()
  const stopped = waitForExecutorDaemonShutdown(parentLiveness)
  parentLiveness.end()
  await stopped
  assert.equal(parentLiveness.readableEnded, true)
})
