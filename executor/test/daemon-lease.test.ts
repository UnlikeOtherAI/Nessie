import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { acquireExecutorDaemonLease } from '../src/daemon-lease.js'

test('a daemon lease prevents duplicate execution and removes a stale lease', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-daemon-lease-'))
  try {
    const first = await acquireExecutorDaemonLease(stateDir)
    await assert.rejects(acquireExecutorDaemonLease(stateDir), /EXECUTOR_DAEMON_ALREADY_RUNNING/)
    await first.release()
    await writeFile(join(stateDir, 'daemon.pid'), '999999999\n', { mode: 0o600 })
    const reconciled = await acquireExecutorDaemonLease(stateDir)
    await reconciled.release()
  } finally {
    await rm(stateDir, { force: true, recursive: true })
  }
})
