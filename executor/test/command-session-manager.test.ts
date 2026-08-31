import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ExecutorCommandEnvelope } from '@nessie/schemas'

import { createExecutorCommandSessionManager } from '../src/command-session-manager.js'
import type { GuestVmSession } from '../src/guest-vm-session.js'

const runId = '00000000-0000-4000-8000-000000000451'

const commandFor = (args: Record<string, unknown>): ExecutorCommandEnvelope => ({
  argumentDigest: `sha256:${'0'.repeat(64)}` as never,
  bindingFence: '1',
  bindingId: '00000000-0000-4000-8000-000000000452' as never,
  capabilityRevision: 1,
  commandId: '00000000-0000-4000-8000-000000000453' as never,
  expiresAt: '2099-08-12T12:00:00.000Z',
  idempotencyKey: 'command-session-manager-test',
  operationKey: 'command.run',
  payload: { args, runId },
})

const stateFor = (workspaceRoot: string) => ({
  apiBaseUrl: 'https://api.example.test',
  browserSandbox: {
    allowedOrigins: ['https://app.example.test'],
    guestInitrdBuilderPath: '/private/builder',
    guestRuntimeBundlePath: '/private/runtime',
    kernelPath: '/private/kernel',
    vmHelperPath: '/private/helper',
  },
  descriptor: {
    limits: { maxCommandRuntimeSeconds: 20, maxResultBytes: 20_000, maxSessions: 1 },
    operationKeys: ['command.run', 'workspace.review', 'sandbox.stop'],
    profiles: ['workspace_sandbox'],
    revision: 1,
  },
  executorId: '00000000-0000-4000-8000-000000000454',
  machinePrivateKey: 'private',
  machinePublicKey: 'public',
  workspaceRoot,
})

test('command session starts one no-egress COW guest and forwards an argv request without a shell', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-command-manager-'))
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nessie-executor-command-workspace-'))
  let resolveClosed: (() => void) | undefined
  const requests: Array<Record<string, unknown>> = []
  const session: GuestVmSession = {
    actBrowser: async () => ({ status: 'acted' }),
    closed: new Promise<void>((resolve) => { resolveClosed = resolve }),
    closeCodingSession: async () => {},
    inspectRuntime: async () => ({ browser: false, claude: false, codex: true, tmux: false }),
    launchCodingSession: async () => {},
    observeBrowser: async () => ({ accessibilityTree: [], targets: [] }),
    observeCodingSession: async () => ({ agent: 'codex', lifecycle: 'running' }),
    openBrowser: async () => {},
    runCommand: async (request) => {
      requests.push(request)
      return { exitCode: 0, output: 'passed', success: true }
    },
    stop: async () => { resolveClosed?.() },
  }
  try {
    const manager = createExecutorCommandSessionManager(stateDir, stateFor(workspaceRoot), {
      startSession: async (input) => {
        assert.equal(input.egressPolicy, undefined)
        assert.equal(input.codexAuthProfilePath, undefined)
        assert.equal(input.lease.runId, runId)
        return session
      },
    })
    assert.deepEqual(
      await manager.run(commandFor({ args: ['test'], cwd: 'packages/runtime', program: 'pnpm' }), runId),
      { exitCode: 0, output: 'passed', success: true },
    )
    assert.deepEqual(requests, [{
      args: ['test'],
      cwd: 'packages/runtime',
      maxResultBytes: 8_192,
      program: 'pnpm',
      runtimeSeconds: 20,
    }])
    assert.deepEqual(
      await manager.run(commandFor({ args: ['-c', 'id'], program: 'sh' }), runId),
      { code: 'EXECUTOR_COMMAND_DENIED', success: false },
    )
    assert.equal(requests.length, 1)
    assert.equal(await manager.stop(runId), true)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})

test('command session refuses a guest without the command runtime', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-command-runtime-'))
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nessie-executor-command-runtime-workspace-'))
  let stopped = 0
  const session: GuestVmSession = {
    actBrowser: async () => ({ status: 'acted' }),
    closed: new Promise<void>(() => {}),
    closeCodingSession: async () => {},
    inspectRuntime: async () => ({ browser: false, claude: false, codex: false, tmux: false }),
    launchCodingSession: async () => {},
    observeBrowser: async () => ({ accessibilityTree: [], targets: [] }),
    observeCodingSession: async () => ({ agent: 'codex', lifecycle: 'running' }),
    openBrowser: async () => {},
    runCommand: async () => ({ exitCode: 0, output: '', success: true }),
    stop: async () => { stopped += 1 },
  }
  try {
    const manager = createExecutorCommandSessionManager(stateDir, stateFor(workspaceRoot), {
      startSession: async () => session,
    })
    assert.deepEqual(
      await manager.run(commandFor({ args: [], program: 'pnpm' }), runId),
      { code: 'EXECUTOR_COMMAND_UNAVAILABLE', success: false },
    )
    assert.equal(stopped, 1)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})
