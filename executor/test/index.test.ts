import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { executeExecutorCommand } from '../src/daemon.js'
import { parseCommand } from '../src/index.js'
import type { ExecutorHost } from '../src/host-platform.js'
import { configureExecutorLocalPolicy } from '../src/pair.js'
import {
  promotionManifestForSandbox,
  stopSandboxWorkspace,
  workspaceForRun,
  writeSandboxFile,
} from '../src/sandbox-workspace.js'
import { loadExecutorState, saveExecutorState } from '../src/state-store.js'
import { listWorkspaceFiles, readWorkspaceFile } from '../src/workspace.js'
import { canonicalExecutorJson, type ExecutorCommandEnvelope } from '@nessie/schemas'

// The configure path now asks the host what sandbox it can start, so this
// pins a host with one instead of depending on the machine running the suite.
const sandboxHost: ExecutorHost = {
  platform: { architecture: 'arm64', os: 'macos', osMajorVersion: 15 },
  sandboxBackend: 'virtualization_framework',
  supervisor: 'desktop',
}

const commandFor = (
  operationKey: ExecutorCommandEnvelope['operationKey'],
  payload: Record<string, unknown>,
): ExecutorCommandEnvelope => ({
  argumentDigest: `sha256:${createHash('sha256').update(canonicalExecutorJson(payload)).digest('hex')}` as never,
  bindingFence: '1',
  bindingId: '00000000-0000-4000-8000-000000000201' as never,
  capabilityRevision: 1,
  commandId: '00000000-0000-4000-8000-000000000202' as never,
  expiresAt: '2099-08-12T12:00:00.000Z',
  idempotencyKey: 'executor-command-test',
  operationKey,
  payload,
})

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

test('pair accepts a challenge from standard input without putting it in process arguments', () => {
  assert.deepEqual(
    parseCommand([
      'pair',
      '--api', 'https://api.example.test',
      '--enrollment', '00000000-0000-4000-8000-000000000001',
      '--challenge-stdin',
      '--state-dir', '/private/tmp/nessie-executor',
      '--workspace', '/private/tmp/nessie-workspace',
    ]),
    {
      apiBaseUrl: 'https://api.example.test',
      challengeFromStandardInput: true,
      enrollmentId: '00000000-0000-4000-8000-000000000001',
      kind: 'pair',
      stateDir: '/private/tmp/nessie-executor',
      workspaceRoot: '/private/tmp/nessie-workspace',
    },
  )
  assert.throws(
    () => parseCommand([
      'pair', '--api', 'https://api.example.test', '--enrollment', 'x',
      '--challenge', 'x', '--challenge-stdin', '--state-dir', '/private/tmp/nessie-executor',
      '--workspace', '/private/tmp/nessie-workspace',
    ]),
    /Usage/,
  )
})

test('desktop pairing keeps both the challenge and workspace path off the process list', () => {
  assert.deepEqual(
    parseCommand([
      'pair',
      '--api', 'https://api.example.test',
      '--enrollment', '00000000-0000-4000-8000-000000000001',
      '--pair-input-stdin',
      '--state-dir', '/private/tmp/nessie-executor',
    ]),
    {
      apiBaseUrl: 'https://api.example.test',
      enrollmentId: '00000000-0000-4000-8000-000000000001',
      kind: 'pair',
      pairingInputFromStandardInput: true,
      stateDir: '/private/tmp/nessie-executor',
    },
  )
  assert.throws(
    () => parseCommand([
      'pair', '--api', 'https://api.example.test', '--enrollment', 'x',
      '--pair-input-stdin', '--workspace', '/private/tmp/nessie-workspace',
      '--state-dir', '/private/tmp/nessie-executor',
    ]),
    /Usage/,
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

test('only the desktop development process may use the exact local API origin', () => {
  const previous = process.env.NESSIE_EXECUTOR_ALLOW_LOCAL_API
  try {
    process.env.NESSIE_EXECUTOR_ALLOW_LOCAL_API = '1'
    assert.equal(
      parseCommand([
        'pair', '--api', 'http://127.0.0.1:5454', '--enrollment', 'x',
        '--challenge', 'x', '--state-dir', '/private/tmp/nessie-executor',
        '--workspace', '/private/tmp/nessie-workspace',
      ]).apiBaseUrl,
      'http://127.0.0.1:5454',
    )
    assert.throws(
      () => parseCommand([
        'pair', '--api', 'http://localhost:5454', '--enrollment', 'x',
        '--challenge', 'x', '--state-dir', '/private/tmp/nessie-executor',
        '--workspace', '/private/tmp/nessie-workspace',
      ]),
      /HTTPS URL/,
    )
  } finally {
    if (previous === undefined) delete process.env.NESSIE_EXECUTOR_ALLOW_LOCAL_API
    else process.env.NESSIE_EXECUTOR_ALLOW_LOCAL_API = previous
  }
})

test('the daemon refuses commands without a state directory', () => {
  assert.throws(() => parseCommand(['serve']), /state-dir/)
})

test('desktop-supervised daemon reads its parent-liveness pipe only when explicitly requested', () => {
  assert.deepEqual(
    parseCommand(['serve', '--parent-liveness-stdin', '--state-dir', '/private/tmp/nessie-executor']),
    { kind: 'serve', parentLivenessFromStandardInput: true, stateDir: '/private/tmp/nessie-executor' },
  )
})

test('Codex configuration requires only local owner-controlled sources', () => {
  assert.deepEqual(
    parseCommand([
      'configure-codex',
      '--state-dir', '/private/tmp/nessie-executor',
      '--auth-profile', '/private/tmp/codex-auth.json',
      '--guest-initrd-builder', '/private/tmp/build-initrd',
      '--kernel', '/private/tmp/kernel',
      '--vm-helper', '/private/tmp/vm-helper',
      '--runtime-bundle', '/private/tmp/runtime',
    ]),
    {
      codexAuthProfilePath: '/private/tmp/codex-auth.json',
      guestInitrdBuilderPath: '/private/tmp/build-initrd',
      guestRuntimeBundlePath: '/private/tmp/runtime',
      kernelPath: '/private/tmp/kernel',
      kind: 'configure-codex',
      stateDir: '/private/tmp/nessie-executor',
      vmHelperPath: '/private/tmp/vm-helper',
    },
  )
})

test('local policy configuration proposes only implemented COW operations', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-configure-'))
  const state = {
    apiBaseUrl: 'https://api.example.test',
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['file.list', 'file.read'],
      profiles: ['workspace_sandbox'],
      revision: 3,
    },
    executorId: '00000000-0000-4000-8000-000000000006',
    machinePrivateKey: 'private',
    machinePublicKey: 'public',
    workspaceRoot: '/private/tmp/nessie-workspace',
  }
  try {
    await saveExecutorState(stateDir, state)
    assert.deepEqual(
      parseCommand([
        'configure',
        '--state-dir', stateDir,
        '--operations', 'file.write,file.read',
      ]),
      { kind: 'configure', operationKeys: ['file.write', 'file.read'], stateDir },
    )
    const configured = await configureExecutorLocalPolicy(
      stateDir,
      state,
      ['file.write', 'file.read'],
      undefined,
      sandboxHost,
    )
    assert.deepEqual(configured.descriptor, {
      ...state.descriptor,
      operationKeys: ['file.read', 'file.write'],
      profiles: ['workspace_sandbox'],
      revision: 4,
    })
    assert.deepEqual((await loadExecutorState(stateDir)).descriptor, configured.descriptor)
    await assert.rejects(
      configureExecutorLocalPolicy(stateDir, configured, ['browser.open'], undefined, sandboxHost),
      /browser\.open, browser\.observe, and browser\.act must be enabled together/,
    )
    await assert.rejects(
      configureExecutorLocalPolicy(stateDir, configured, ['workspace.promote'], undefined, sandboxHost),
      /native helper path/,
    )
  } finally {
    await rm(stateDir, { force: true, recursive: true })
  }
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

test('sandbox writes use a daemon-owned COW workspace and never touch the paired root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-cow-source-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-cow-state-'))
  const runId = '00000000-0000-4000-8000-000000000101'
  try {
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'base.txt'), 'host source')

    assert.deepEqual(
      await writeSandboxFile(stateDir, root, runId, {
        content: 'draft only',
        path: 'nested/draft.txt',
      }),
      { byteCount: 10, path: 'nested/draft.txt', success: true },
    )
    const scratch = await workspaceForRun(stateDir, root, runId)
    assert.deepEqual(
      await readWorkspaceFile(scratch, { path: 'nested/draft.txt' }),
      {
        byteCount: 10,
        content: 'draft only',
        path: 'nested/draft.txt',
        success: true,
        truncated: false,
      },
    )
    assert.equal(await readFile(join(root, 'nested', 'base.txt'), 'utf8'), 'host source')
    await assert.rejects(readFile(join(root, 'nested', 'draft.txt'), 'utf8'), { code: 'ENOENT' })

    assert.equal(await stopSandboxWorkspace(stateDir, runId), true)
    assert.equal(await workspaceForRun(stateDir, root, runId), await realpath(root))
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('sandbox workspace paths exclude the native promotion journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-journal-source-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-journal-state-'))
  try {
    await mkdir(join(root, '.nessie-executor-promotions'))
    await assert.rejects(
      writeSandboxFile(stateDir, root, '00000000-0000-4000-8000-000000000105', {
        content: 'forbidden',
        path: '.nessie-executor-promotions/forbidden.txt',
      }),
      /journal state/,
    )
    assert.deepEqual(
      await listWorkspaceFiles(root, { path: '.' }),
      { entries: [], path: '.', success: true, truncated: false },
    )
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('copy-on-write sandbox setup fails closed on symbolic links in the paired root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-cow-link-source-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-cow-link-state-'))
  const outside = await mkdtemp(join(tmpdir(), 'nessie-executor-cow-link-outside-'))
  try {
    await symlink(outside, join(root, 'outside-link'))
    await assert.rejects(
      writeSandboxFile(stateDir, root, '00000000-0000-4000-8000-000000000102', {
        content: 'must not write',
        path: 'draft.txt',
      }),
      /symbolic links/,
    )
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
    await rm(outside, { force: true, recursive: true })
  }
})

test('daemon commands bind COW drafts to one run and never write the paired root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-daemon-source-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-daemon-state-'))
  const runId = '00000000-0000-4000-8000-000000000203'
  const state = {
    apiBaseUrl: 'https://api.example.test',
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['file.list', 'file.read', 'file.write', 'workspace.review', 'sandbox.stop'],
      profiles: ['workspace_sandbox'],
      revision: 1,
    },
    executorId: '00000000-0000-4000-8000-000000000204',
    machinePrivateKey: 'private',
    machinePublicKey: 'public',
    workspaceRoot: root,
  }
  try {
    await writeFile(join(root, 'original.txt'), 'host root')
    assert.deepEqual(
      await executeExecutorCommand(stateDir, state, commandFor('file.write', {
        args: { content: 'draft', path: 'draft.txt' },
        runId,
      })),
      { byteCount: 5, path: 'draft.txt', success: true },
    )
    assert.deepEqual(
      await executeExecutorCommand(stateDir, state, commandFor('file.read', {
        args: { path: 'draft.txt' },
        runId,
      })),
      { byteCount: 5, content: 'draft', path: 'draft.txt', success: true, truncated: false },
    )
    await assert.rejects(readFile(join(root, 'draft.txt'), 'utf8'), { code: 'ENOENT' })
    const review = await executeExecutorCommand(stateDir, state, commandFor('workspace.review', {
      args: {},
      runId,
    }))
    assert.deepEqual(review, {
      changeCount: 1,
      changes: [{ byteCount: 5, kind: 'created', path: 'draft.txt' }],
      manifestDigest: review.manifestDigest,
      success: true,
    })
    assert.match(String(review.manifestDigest), /^sha256:[a-f0-9]{64}$/)
    assert.deepEqual(
      await executeExecutorCommand(stateDir, state, commandFor('sandbox.stop', { args: {}, runId })),
      { status: 'stopped', success: true },
    )
    assert.deepEqual(
      await executeExecutorCommand(stateDir, state, commandFor('file.list', { args: {}, runId })),
      {
        entries: [{ kind: 'file', name: 'original.txt' }],
        path: '.',
        success: true,
        truncated: false,
      },
    )
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('promotion remains unavailable without an owner-verified native helper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-promotion-source-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-promotion-state-'))
  const runId = '00000000-0000-4000-8000-000000000207'
  const state = {
    apiBaseUrl: 'https://api.example.test',
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['file.write', 'workspace.promote'],
      profiles: ['workspace_sandbox'],
      revision: 1,
    },
    executorId: '00000000-0000-4000-8000-000000000208',
    machinePrivateKey: 'private',
    machinePublicKey: 'public',
    workspaceRoot: root,
  }
  try {
    await writeFile(join(root, 'original.txt'), 'base')
    await executeExecutorCommand(stateDir, state, commandFor('file.write', {
      args: { content: 'draft', overwrite: true, path: 'original.txt' },
      runId,
    }))
    const manifest = await promotionManifestForSandbox(stateDir, runId)
    assert.deepEqual(
      await executeExecutorCommand(stateDir, state, commandFor('workspace.promote', {
        args: {
          approvalDigest: `sha256:${'0'.repeat(64)}`,
          manifestDigest: manifest.manifestDigest,
          promotionId: '00000000-0000-4000-8000-000000000209',
        },
        runId,
      })),
      { code: 'EXECUTOR_NATIVE_HELPER_UNAVAILABLE', success: false },
    )
    assert.equal(await readFile(join(root, 'original.txt'), 'utf8'), 'base')
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('a draft review digest binds file hashes even when byte counts do not change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-manifest-source-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-manifest-state-'))
  const runId = '00000000-0000-4000-8000-000000000206'
  try {
    await writeFile(join(root, 'original.txt'), 'base')
    await writeSandboxFile(stateDir, root, runId, {
      content: 'draft',
      overwrite: true,
      path: 'original.txt',
    })
    const first = await promotionManifestForSandbox(stateDir, runId)
    await writeSandboxFile(stateDir, root, runId, {
      content: 'other',
      overwrite: true,
      path: 'original.txt',
    })
    const second = await promotionManifestForSandbox(stateDir, runId)
    assert.equal(first.changes[0]?.draft?.byteCount, second.changes[0]?.draft?.byteCount)
    assert.notEqual(first.manifestDigest, second.manifestDigest)
    assert.equal('draft' in first.changes[0]!, true)
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('daemon commands reject a missing server-provenanced run identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-daemon-invalid-source-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-daemon-invalid-state-'))
  const state = {
    apiBaseUrl: 'https://api.example.test',
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['file.write'],
      profiles: ['workspace_sandbox'],
      revision: 1,
    },
    executorId: '00000000-0000-4000-8000-000000000205',
    machinePrivateKey: 'private',
    machinePublicKey: 'public',
    workspaceRoot: root,
  }
  try {
    assert.deepEqual(
      await executeExecutorCommand(stateDir, state, commandFor('file.write', {
        args: { content: 'draft', path: 'draft.txt' },
      })),
      { code: 'EXECUTOR_COMMAND_RUN_INVALID', success: false },
    )
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})
