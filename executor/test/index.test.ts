import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parseCommand } from '../src/index.js'
import { loadExecutorState, saveExecutorState } from '../src/state-store.js'

test('pair requires an explicit API URL and owner-controlled state directory', () => {
  assert.deepEqual(
    parseCommand([
      'pair',
      '--api', 'https://api.example.test',
      '--enrollment', '00000000-0000-4000-8000-000000000001',
      '--challenge', 'opaque-token',
      '--state-dir', '/private/tmp/nessie-executor',
    ]),
    {
      apiBaseUrl: 'https://api.example.test',
      challenge: 'opaque-token',
      enrollmentId: '00000000-0000-4000-8000-000000000001',
      kind: 'pair',
      stateDir: '/private/tmp/nessie-executor',
    },
  )
})

test('the daemon rejects an insecure API origin', () => {
  assert.throws(
    () => parseCommand([
      'pair', '--api', 'http://api.example.test', '--enrollment', 'x',
      '--challenge', 'x', '--state-dir', '/private/tmp/nessie-executor',
    ]),
    /HTTPS URL/,
  )
})

test('the daemon refuses commands without a state directory', () => {
  assert.throws(() => parseCommand(['serve']), /state-dir/)
})

test('state storage rejects shared or symbolic paths and preserves owner-only state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-test-'))
  const shared = join(root, 'shared')
  const safe = join(root, 'safe')
  const linked = join(root, 'linked')
  const state = {
    apiBaseUrl: 'https://api.example.test',
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['sandbox.stop'],
      profiles: ['workspace_sandbox'],
      revision: 1,
    },
    executorId: '00000000-0000-4000-8000-000000000001',
    machinePrivateKey: 'private',
    machinePublicKey: 'public',
  }
  try {
    await saveExecutorState(shared, state)
    await chmod(shared, 0o755)
    await assert.rejects(() => loadExecutorState(shared), /must not be accessible/)

    await saveExecutorState(safe, state)
    assert.deepEqual(await loadExecutorState(safe), state)

    await symlink(safe, linked)
    await assert.rejects(() => saveExecutorState(linked, state), /ordinary directory/)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
