import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ExecutorCommandEnvelope } from '@nessie/schemas'

import { createExecutorBrowserSessionManager } from '../src/browser-session-manager.js'
import type { GuestVmSession } from '../src/guest-vm-session.js'
import { stopSandboxWorkspace } from '../src/sandbox-workspace.js'

const runId = '00000000-0000-4000-8000-000000000301'
const secondRunId = '00000000-0000-4000-8000-000000000306'

const commandFor = (
  operationKey: 'browser.act' | 'browser.open' | 'browser.observe',
  args: Record<string, unknown>,
  commandRunId = runId,
): ExecutorCommandEnvelope => ({
  argumentDigest: `sha256:${'0'.repeat(64)}` as never,
  bindingFence: '1',
  bindingId: '00000000-0000-4000-8000-000000000302' as never,
  capabilityRevision: 1,
  commandId: operationKey === 'browser.open'
    ? '00000000-0000-4000-8000-000000000303' as never
    : '00000000-0000-4000-8000-000000000304' as never,
  expiresAt: '2099-08-12T12:00:00.000Z',
  idempotencyKey: 'browser-session-manager-test',
  operationKey,
  payload: { args, runId: commandRunId },
})

test('browser sessions use the exact run lease, reject a second launch, and stop before sandbox teardown', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-manager-'))
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-workspace-'))
  let resolveClosed: (() => void) | undefined
  let starts = 0
  let stops = 0
  const actions: Array<Record<string, unknown>> = []
  const opened: string[] = []
  const session: GuestVmSession = {
    actBrowser: async (action) => {
      actions.push(action)
      return { status: 'acted' }
    },
    closed: new Promise<void>((resolve) => { resolveClosed = resolve }),
    closeCodingSession: async () => {},
    inspectRuntime: async () => ({ browser: true, claude: false, codex: false, tmux: false }),
    launchCodingSession: async () => {},
    observeBrowser: async () => ({
      accessibilityTree: [{ name: 'Save', nodeId: 9, role: 'button' }],
      targets: [{ title: 'Guide', type: 'page', url: 'https://app.example.test/guide' }],
    }),
    observeCodingSession: async () => ({ agent: 'codex', lifecycle: 'running', output: '' }),
    openBrowser: async (url) => { opened.push(url) },
    runCommand: async () => ({ exitCode: 0, output: '', success: true }),
    stop: async () => { stops += 1; resolveClosed?.() },
  }
  const state = {
    apiBaseUrl: 'https://api.example.test',
    browserSandbox: {
      allowedOrigins: ['https://app.example.test'],
      guestInitrdBuilderPath: '/private/builder',
      guestRuntimeBundlePath: '/private/runtime',
      kernelPath: '/private/kernel',
      vmHelperPath: '/private/helper',
    },
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['browser.open', 'browser.observe', 'browser.act', 'sandbox.stop'],
      profiles: ['workspace_sandbox'],
      revision: 1,
    },
    executorId: '00000000-0000-4000-8000-000000000305',
    machinePrivateKey: 'private',
    machinePublicKey: 'public',
    workspaceRoot,
  }
  try {
    const manager = createExecutorBrowserSessionManager(stateDir, state, {
      startSession: async (input) => {
        starts += 1
        assert.equal(input.lease.runId, runId)
        assert.equal(input.lease.bindingFence, '1')
        assert.deepEqual(input.egressPolicy, { allowedOrigins: ['https://app.example.test'] })
        return session
      },
    })
    assert.deepEqual(
      await manager.open(commandFor('browser.open', { url: 'https://blocked.example.test/' }), runId),
      { code: 'EXECUTOR_BROWSER_DENIED', success: false },
    )
    assert.equal(starts, 0)
    assert.deepEqual(
      await manager.open(commandFor('browser.open', { url: 'https://app.example.test/guide' }), runId),
      { status: 'opened', success: true },
    )
    assert.deepEqual(opened, ['https://app.example.test/guide'])
    assert.deepEqual(
      await manager.open(commandFor('browser.open', { url: 'https://app.example.test/again' }), runId),
      { code: 'EXECUTOR_BROWSER_SESSION_USED', success: false },
    )
    assert.deepEqual(
      await manager.open(
        commandFor('browser.open', { url: 'https://app.example.test/second' }, secondRunId),
        secondRunId,
      ),
      { code: 'EXECUTOR_BROWSER_CAPACITY_REACHED', success: false },
    )
    assert.deepEqual(
      await manager.observe(commandFor('browser.observe', {}), runId),
      {
        accessibilityTree: [{ name: 'Save', nodeId: 9, role: 'button' }],
        success: true,
        targets: [{ title: 'Guide', type: 'page', url: 'https://app.example.test/guide' }],
      },
    )
    assert.deepEqual(
      await manager.act(commandFor('browser.act', { action: 'navigate', url: 'https://blocked.example.test/' }), runId),
      { code: 'EXECUTOR_BROWSER_DENIED', success: false },
    )
    assert.deepEqual(
      await manager.act(commandFor('browser.act', { action: 'click', nodeId: 9 }), runId),
      { status: 'acted', success: true },
    )
    assert.deepEqual(actions, [{ action: 'click', nodeId: 9 }])
    assert.equal(await manager.stop(runId), true)
    assert.equal(stops, 1)
    assert.deepEqual(
      await manager.open(commandFor('browser.open', { url: 'https://app.example.test/reopen' }), runId),
      { code: 'EXECUTOR_BROWSER_SESSION_USED', success: false },
    )
    assert.deepEqual(
      await manager.observe(commandFor('browser.observe', {}), runId),
      { code: 'EXECUTOR_BROWSER_UNAVAILABLE', success: false },
    )
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})

test('browser session startup is cancelled by fencing before it can open a page', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-fence-'))
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-fence-workspace-'))
  let resolveStart: ((value: GuestVmSession) => void) | undefined
  let signalStart: (() => void) | undefined
  let resolveClosed: (() => void) | undefined
  let opens = 0
  let stops = 0
  const startGate = new Promise<GuestVmSession>((resolve) => { resolveStart = resolve })
  const started = new Promise<void>((resolve) => { signalStart = resolve })
  const session: GuestVmSession = {
    actBrowser: async () => ({ status: 'acted' }),
    closed: new Promise<void>((resolve) => { resolveClosed = resolve }),
    closeCodingSession: async () => {},
    inspectRuntime: async () => ({ browser: true, claude: false, codex: false, tmux: false }),
    launchCodingSession: async () => {},
    observeBrowser: async () => ({ accessibilityTree: [], targets: [] }),
    observeCodingSession: async () => ({ agent: 'codex', lifecycle: 'running', output: '' }),
    openBrowser: async () => { opens += 1 },
    runCommand: async () => ({ exitCode: 0, output: '', success: true }),
    stop: async () => { stops += 1; resolveClosed?.() },
  }
  const state = {
    apiBaseUrl: 'https://api.example.test',
    browserSandbox: {
      allowedOrigins: ['https://app.example.test'],
      guestInitrdBuilderPath: '/private/builder',
      guestRuntimeBundlePath: '/private/runtime',
      kernelPath: '/private/kernel',
      vmHelperPath: '/private/helper',
    },
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['browser.open', 'browser.observe', 'browser.act', 'sandbox.stop'],
      profiles: ['workspace_sandbox'],
      revision: 1,
    },
    executorId: '00000000-0000-4000-8000-000000000305',
    machinePrivateKey: 'private',
    machinePublicKey: 'public',
    workspaceRoot,
  }
  try {
    const manager = createExecutorBrowserSessionManager(stateDir, state, {
      startSession: async () => {
        signalStart?.()
        return startGate
      },
    })
    const opening = manager.open(commandFor('browser.open', { url: 'https://app.example.test/guide' }), runId)
    await started
    const stopping = manager.stopAll()
    resolveStart?.(session)
    await stopping
    assert.deepEqual(await opening, { code: 'EXECUTOR_BROWSER_UNAVAILABLE', success: false })
    assert.equal(opens, 0)
    assert.equal(stops, 1)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})

test('failed browser startup releases the exact COW lease so sandbox.stop can tear it down', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-lease-'))
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-lease-workspace-'))
  const state = {
    apiBaseUrl: 'https://api.example.test',
    browserSandbox: {
      allowedOrigins: ['https://app.example.test'],
      guestInitrdBuilderPath: '/private/builder',
      guestRuntimeBundlePath: '/private/runtime',
      kernelPath: '/private/kernel',
      vmHelperPath: '/private/helper',
    },
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['browser.open', 'browser.observe', 'browser.act', 'sandbox.stop'],
      profiles: ['workspace_sandbox'],
      revision: 1,
    },
    executorId: '00000000-0000-4000-8000-000000000305',
    machinePrivateKey: 'private',
    machinePublicKey: 'public',
    workspaceRoot,
  }
  try {
    const manager = createExecutorBrowserSessionManager(stateDir, state, {
      startSession: async () => { throw new Error('guest unavailable') },
    })
    assert.deepEqual(
      await manager.open(commandFor('browser.open', { url: 'https://app.example.test/guide' }), runId),
      { code: 'EXECUTOR_BROWSER_UNAVAILABLE', success: false },
    )
    assert.equal(await stopSandboxWorkspace(stateDir, runId), true)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})

test('a rejected guest stop cannot strand a startup lease', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-stop-lease-'))
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-stop-lease-workspace-'))
  const state = {
    apiBaseUrl: 'https://api.example.test',
    browserSandbox: {
      allowedOrigins: ['https://app.example.test'],
      guestInitrdBuilderPath: '/private/builder',
      guestRuntimeBundlePath: '/private/runtime',
      kernelPath: '/private/kernel',
      vmHelperPath: '/private/helper',
    },
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['browser.open', 'browser.observe', 'browser.act', 'sandbox.stop'],
      profiles: ['workspace_sandbox'],
      revision: 1,
    },
    executorId: '00000000-0000-4000-8000-000000000305',
    machinePrivateKey: 'private',
    machinePublicKey: 'public',
    workspaceRoot,
  }
  try {
    const manager = createExecutorBrowserSessionManager(stateDir, state, {
      startSession: async () => ({
        actBrowser: async () => ({ status: 'acted' }),
        closed: new Promise<void>(() => {}),
        closeCodingSession: async () => {},
        inspectRuntime: async () => ({ browser: false, claude: false, codex: false, tmux: false }),
        launchCodingSession: async () => {},
        observeBrowser: async () => ({ accessibilityTree: [], targets: [] }),
        observeCodingSession: async () => ({ agent: 'codex', lifecycle: 'running', output: '' }),
        openBrowser: async () => {},
        runCommand: async () => ({ exitCode: 0, output: '', success: true }),
        stop: async () => { throw new Error('guest stop failed') },
      }),
    })
    assert.deepEqual(
      await manager.open(commandFor('browser.open', { url: 'https://app.example.test/guide' }), runId),
      { code: 'EXECUTOR_BROWSER_UNAVAILABLE', success: false },
    )
    assert.equal(await stopSandboxWorkspace(stateDir, runId), true)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})
