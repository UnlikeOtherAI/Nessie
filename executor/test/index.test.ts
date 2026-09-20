import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parseCommand } from '../src/index.js'
import type { ExecutorHost } from '../src/host-platform.js'
import { configureExecutorLocalPolicy } from '../src/pair.js'
import { deriveExecutorWorkspaceFolderName } from '../src/workspace-folders.js'
import { loadExecutorState, saveExecutorState } from '../src/state-store.js'

// The configure path now asks the host what sandbox it can start, so this
// pins a host with one instead of depending on the machine running the suite.
const sandboxHost: ExecutorHost = {
  platform: { architecture: 'arm64', os: 'macos', osMajorVersion: 15 },
  sandboxBackend: 'virtualization_framework',
  supervisor: 'desktop',
}

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
      workspaceFolders: [{ name: 'nessie-workspace', path: '/private/tmp/nessie-workspace' }],
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
      workspaceFolders: [{ name: 'nessie-workspace', path: '/private/tmp/nessie-workspace' }],
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

test('desktop workspace changes keep the selected path off the process list', () => {
  assert.deepEqual(
    parseCommand([
      'configure',
      '--configuration-input-stdin',
      '--state-dir', '/private/tmp/nessie-executor',
    ]),
    {
      configurationInputFromStandardInput: true,
      kind: 'configure',
      stateDir: '/private/tmp/nessie-executor',
    },
  )
  assert.throws(
    () => parseCommand([
      'configure', '--configuration-input-stdin',
      '--workspace', '/private/tmp/nessie-workspace',
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
    /must be HTTPS/,
  )
})

test('a preset and a self-hosted origin both pair, a look-alike does not', () => {
  const origin = (value: string): string => parseCommand([
    'pair', '--api', value, '--enrollment', 'x',
    '--challenge', 'x', '--state-dir', '/private/tmp/nessie-executor',
    '--workspace', '/private/tmp/nessie-workspace',
  ]).apiBaseUrl!

  assert.equal(origin('nessie'), 'https://api.nessie.works')
  assert.equal(origin('deeptest'), 'https://api.deeptest.live')
  // Nessie is open source; somebody's own server is an ordinary case.
  assert.equal(origin('https://nessie.example.com'), 'https://nessie.example.com')
  // A path is how one host is dressed up as another; it never reaches a key.
  assert.throws(
    () => origin('https://evil.example.com/api.nessie.works'),
    /origin only/,
  )
})

test('only the desktop development process may use the exact local API origin', () => {
  const previous = process.env.NESSIE_EXECUTOR_ALLOW_LOCAL_API
  const previousPort = process.env.NESSIE_API_PORT
  try {
    process.env.NESSIE_EXECUTOR_ALLOW_LOCAL_API = '1'
    process.env.NESSIE_API_PORT = '5464'
    assert.equal(
      parseCommand([
        'pair', '--api', 'http://127.0.0.1:5464', '--enrollment', 'x',
        '--challenge', 'x', '--state-dir', '/private/tmp/nessie-executor',
        '--workspace', '/private/tmp/nessie-workspace',
      ]).apiBaseUrl,
      'http://127.0.0.1:5464',
    )
    assert.throws(
      () => parseCommand([
        'pair', '--api', 'http://127.0.0.1:5454', '--enrollment', 'x',
        '--challenge', 'x', '--state-dir', '/private/tmp/nessie-executor',
        '--workspace', '/private/tmp/nessie-workspace',
      ]),
      /must be HTTPS/,
    )
  } finally {
    if (previous === undefined) delete process.env.NESSIE_EXECUTOR_ALLOW_LOCAL_API
    else process.env.NESSIE_EXECUTOR_ALLOW_LOCAL_API = previous
    if (previousPort === undefined) delete process.env.NESSIE_API_PORT
    else process.env.NESSIE_API_PORT = previousPort
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

test('the cookie-import native host receives only a pinned caller and owner-only state path', () => {
  assert.deepEqual(
    parseCommand([
      'native-browser-cookie-import',
      '--state-root', '/private/tmp/nessie-executors',
      '--extension-origin', 'chrome-extension://release-id/',
      '--caller-origin', 'chrome-extension://release-id/',
    ]),
    {
      callerOrigin: 'chrome-extension://release-id/',
      expectedExtensionOrigin: 'chrome-extension://release-id/',
      kind: 'native-browser-cookie-import',
      requireDevelopmentLocalApi: false,
      stateRoot: '/private/tmp/nessie-executors',
    },
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
  const replacementWorkspace = await mkdtemp(join(tmpdir(), 'nessie-executor-replacement-workspace-'))
  const blockedWorkspace = await mkdtemp(join(tmpdir(), 'nessie-executor-blocked-workspace-'))
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
    workspaceFolders: [{ name: 'work', path: '/private/tmp/nessie-workspace' }],
  }
  try {
    await saveExecutorState(stateDir, state)
    assert.deepEqual(
      parseCommand([
        'configure',
        '--state-dir', stateDir,
        '--operations', 'file.write,file.read',
        '--workspace', replacementWorkspace,
      ]),
      {
        kind: 'configure',
        operationKeys: ['file.write', 'file.read'],
        stateDir,
        workspaceFolders: [{
          name: deriveExecutorWorkspaceFolderName(replacementWorkspace),
          path: replacementWorkspace,
        }],
      },
    )
    const configured = await configureExecutorLocalPolicy(
      stateDir,
      state,
      ['file.write', 'file.read'],
      undefined,
      sandboxHost,
      [{ name: 'replacement', path: replacementWorkspace }],
    )
    assert.deepEqual(configured.descriptor, {
      ...state.descriptor,
      operationKeys: ['file.read', 'file.write'],
      profiles: ['workspace_sandbox'],
      revision: 4,
      workspaceFolders: ['replacement'],
    })
    assert.deepEqual((await loadExecutorState(stateDir)).descriptor, configured.descriptor)
    assert.deepEqual((await loadExecutorState(stateDir)).workspaceFolders, [
      { name: 'replacement', path: await realpath(replacementWorkspace) },
    ])
    await assert.rejects(
      configureExecutorLocalPolicy(stateDir, configured, ['browser.open'], undefined, sandboxHost),
      /browser\.open, browser\.observe, and browser\.act must be enabled together/,
    )
    await assert.rejects(
      configureExecutorLocalPolicy(stateDir, configured, ['workspace.promote'], undefined, sandboxHost),
      /native helper path/,
    )
    await mkdir(join(stateDir, 'runtime'))
    await writeFile(join(stateDir, 'runtime', 'pending-draft'), 'draft')
    await assert.rejects(
      configureExecutorLocalPolicy(
        stateDir,
        configured,
        configured.descriptor.operationKeys,
        undefined,
        sandboxHost,
        [{ name: 'blocked', path: blockedWorkspace }],
      ),
      /Remove every local draft and stop every sandbox/,
    )
  } finally {
    await rm(blockedWorkspace, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
    await rm(replacementWorkspace, { force: true, recursive: true })
  }
})
