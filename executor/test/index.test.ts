import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parseCommand } from '../src/index.js'
import { loadExecutorState, saveExecutorState } from '../src/state-store.js'
import { listWorkspaceFiles, readWorkspaceFile } from '../src/workspace.js'

test('pair requires an explicit API URL and owner-controlled state directory', () => {
  assert.deepEqual(
    parseCommand([
      'pair',
      '--api', 'https://api.example.test',
      '--enrollment', '00000000-0000-4000-8000-000000000001',
      '--challenge', 'opaque-token',
      '--state-dir', '/private/tmp/nessie-executor',
      '--workspace', '/private/tmp/nessie-workspace',
    ]),
    {
      apiBaseUrl: 'https://api.example.test',
      challenge: 'opaque-token',
      enrollmentId: '00000000-0000-4000-8000-000000000001',
      kind: 'pair',
      stateDir: '/private/tmp/nessie-executor',
      workspaceRoot: '/private/tmp/nessie-workspace',
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
    workspaceRoot: '/private/tmp/nessie-workspace',
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

test('the read-only workspace backend keeps every path inside the paired root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-workspace-'))
  const outside = await mkdtemp(join(tmpdir(), 'nessie-executor-outside-'))
  try {
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'notes.txt'), 'hello executor')
    await writeFile(join(outside, 'secret.txt'), 'not readable')
    await symlink(join(outside, 'secret.txt'), join(root, 'outside-link'))

    assert.deepEqual(
      await listWorkspaceFiles(root, { path: 'nested' }),
      {
        entries: [{ kind: 'file', name: 'notes.txt' }],
        path: 'nested',
        success: true,
        truncated: false,
      },
    )
    assert.deepEqual(
      await readWorkspaceFile(root, { path: 'nested/notes.txt', maxBytes: 5 }),
      {
        byteCount: 5,
        content: 'hello',
        path: 'nested/notes.txt',
        success: true,
        truncated: true,
      },
    )
    await assert.rejects(
      readWorkspaceFile(root, { path: '../outside/secret.txt' }),
      /escapes its root/,
    )
    await assert.rejects(
      readWorkspaceFile(root, { path: 'outside-link' }),
      /symbolic links/,
    )
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(outside, { force: true, recursive: true })
  }
})
