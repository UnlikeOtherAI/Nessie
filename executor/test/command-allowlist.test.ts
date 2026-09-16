import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalExecutorJson, type ExecutorCommandEnvelope } from '@nessie/schemas'

import { executeExecutorCommand } from '../src/daemon.js'
import { buildSignedDescriptor } from '../src/descriptor.js'
import { parseCommand } from '../src/index.js'
import { configureExecutorLocalPolicy } from '../src/pair.js'
import { saveExecutorState } from '../src/state-store.js'
import type { ExecutorCommandSessionManager } from '../src/command-session-manager.js'
import type { ExecutorHost } from '../src/host-platform.js'
import type { ExecutorLocalState } from '../src/state-store.js'

const runId = '00000000-0000-4000-8000-000000000501'

const sandboxHost: ExecutorHost = {
  platform: { architecture: 'arm64', os: 'macos', osMajorVersion: 15 },
  sandboxBackend: 'virtualization_framework',
  supervisor: 'service',
}

const commandFor = (args: Record<string, unknown>): ExecutorCommandEnvelope => {
  const payload = { args, runId }
  return {
    argumentDigest: `sha256:${createHash('sha256').update(canonicalExecutorJson(payload)).digest('hex')}` as never,
    bindingFence: '1',
    bindingId: '00000000-0000-4000-8000-000000000502' as never,
    capabilityRevision: 1,
    commandId: '00000000-0000-4000-8000-000000000503' as never,
    expiresAt: '2099-08-12T12:00:00.000Z',
    idempotencyKey: 'command-allowlist',
    operationKey: 'command.run',
    payload,
  }
}

const stateWith = (commandAllowlist?: string[]): ExecutorLocalState => ({
  apiBaseUrl: 'https://api.example.test',
  browserSandbox: {
    allowedOrigins: ['https://app.example.test'],
    guestInitrdBuilderPath: '/private/builder',
    guestRuntimeBundlePath: '/private/runtime',
    kernelPath: '/private/kernel',
    vmHelperPath: '/private/helper',
  },
  descriptor: {
    ...(commandAllowlist ? { commandAllowlist } : {}),
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
    operationKeys: ['command.run'],
    profiles: ['workspace_sandbox'],
    revision: 1,
  },
  executorId: '00000000-0000-4000-8000-000000000504',
  machinePrivateKey: 'private',
  machinePublicKey: 'public',
  workspaceRoot: '/private/workspace',
})

const countingSessions = (): { calls: string[]; sessions: ExecutorCommandSessionManager } => {
  const calls: string[] = []
  const sessions = {
    run: async (command: ExecutorCommandEnvelope) => {
      calls.push((command.payload.args as { program: string }).program)
      return { exitCode: 0, output: 'done', success: true }
    },
  } as unknown as ExecutorCommandSessionManager
  return { calls, sessions }
}

test('a permitted program runs and an unlisted one never reaches a session', async () => {
  const { calls, sessions } = countingSessions()
  const state = stateWith(['git', 'pnpm'])

  assert.deepEqual(
    await executeExecutorCommand('/private/state', state, commandFor({ args: ['status'], program: 'git' }), {
      commandSessions: sessions,
    }),
    { exitCode: 0, output: 'done', success: true },
  )
  assert.deepEqual(
    await executeExecutorCommand('/private/state', state, commandFor({ args: ['-la'], program: 'ls' }), {
      commandSessions: sessions,
    }),
    { code: 'EXECUTOR_COMMAND_DENIED', success: false },
  )
  // The refusal is the point: a program nobody named must not reach a backend
  // that could boot a guest for it.
  assert.deepEqual(calls, ['git'])
})

test('a policy that never named a program permits none of them', async () => {
  const { calls, sessions } = countingSessions()

  assert.deepEqual(
    await executeExecutorCommand('/private/state', stateWith(), commandFor({ args: [], program: 'git' }), {
      commandSessions: sessions,
    }),
    { code: 'EXECUTOR_COMMAND_DENIED', success: false },
  )
  assert.deepEqual(calls, [])
})

test('the permitted programs are part of what a person reviews', () => {
  const key = generateKeyPairSync('ed25519')
    .privateKey.export({ format: 'der', type: 'pkcs8' })
    .toString('base64url')
  const limits = { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 }
  const base = { limits, operationKeys: ['file.read'], profiles: ['workspace_sandbox'], revision: 2 }
  const withGit = buildSignedDescriptor(key, { ...base, commandAllowlist: ['git'] }, sandboxHost)
  const withNode = buildSignedDescriptor(key, { ...base, commandAllowlist: ['node'] }, sandboxHost)
  const without = buildSignedDescriptor(key, base, sandboxHost)

  assert.deepEqual(withGit.descriptor.commandAllowlist, ['git'])
  assert.equal(without.descriptor.commandAllowlist, undefined)
  // Swapping one permitted program for another is a different policy, so it
  // cannot reuse a digest a person already approved.
  assert.notEqual(withGit.descriptor.localPolicyDigest, withNode.descriptor.localPolicyDigest)
  assert.notEqual(withGit.descriptor.localPolicyDigest, without.descriptor.localPolicyDigest)
})

test('configure stores a canonical list and refuses command.run without one', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-allowlist-'))
  const state = stateWith()
  await saveExecutorState(stateDir, state)

  await assert.rejects(
    configureExecutorLocalPolicy(
      stateDir,
      state,
      ['file.read', 'command.run', 'workspace.review', 'sandbox.stop'],
      undefined,
      sandboxHost,
      state.workspaceRoot,
      [],
    ),
    /Name at least one permitted program/,
  )
  await assert.rejects(
    configureExecutorLocalPolicy(
      stateDir,
      state,
      ['file.read'],
      undefined,
      sandboxHost,
      state.workspaceRoot,
      ['/usr/bin/git'],
    ),
    /bare names/,
  )
  await assert.rejects(
    configureExecutorLocalPolicy(
      stateDir,
      state,
      ['file.read'],
      undefined,
      sandboxHost,
      state.workspaceRoot,
      ['git', 'git'],
    ),
    /bare names/,
  )

  const configured = await configureExecutorLocalPolicy(
    stateDir,
    state,
    ['file.read', 'command.run', 'workspace.review', 'sandbox.stop'],
    undefined,
    sandboxHost,
    state.workspaceRoot,
    ['pnpm', 'git'],
  )
  assert.deepEqual(configured.descriptor.commandAllowlist, ['git', 'pnpm'])
  assert.equal(configured.descriptor.revision, 2)

  // Changing operations without saying anything about tools keeps the tools.
  const kept = await configureExecutorLocalPolicy(
    stateDir,
    configured,
    ['file.read', 'command.run', 'workspace.review', 'sandbox.stop'],
    undefined,
    sandboxHost,
    configured.workspaceRoot,
  )
  assert.deepEqual(kept.descriptor.commandAllowlist, ['git', 'pnpm'])

  // Clearing them leaves no key behind, so the next digest stays canonicalizable.
  const cleared = await configureExecutorLocalPolicy(
    stateDir,
    kept,
    ['file.read'],
    undefined,
    sandboxHost,
    kept.workspaceRoot,
    [],
  )
  assert.equal('commandAllowlist' in cleared.descriptor, false)
  const persisted = JSON.parse(await readFile(join(stateDir, 'executor-state.json'), 'utf8'))
  assert.equal('commandAllowlist' in persisted.descriptor, false)
})

/** `parseCommand` answers a union; only the configure arm carries an allowlist. */
const configureAllowlist = (args: string[]): string[] | undefined => {
  const parsed = parseCommand(args)
  assert.equal(parsed.kind, 'configure')
  return parsed.kind === 'configure' ? parsed.commandAllowlist : undefined
}

test('the CLI names permitted programs, clears them, or refuses to guess', () => {
  assert.deepEqual(
    parseCommand(['configure', '--state-dir', '/private/state', '--operations', 'file.read', '--tools', 'git, pnpm']),
    {
      commandAllowlist: ['git', 'pnpm'],
      kind: 'configure',
      operationKeys: ['file.read'],
      stateDir: '/private/state',
    },
  )
  assert.deepEqual(
    configureAllowlist(['configure', '--state-dir', '/private/state', '--operations', 'file.read', '--clear-tools']),
    [],
  )
  assert.equal(
    configureAllowlist(['configure', '--state-dir', '/private/state', '--operations', 'file.read']),
    undefined,
  )
  assert.throws(
    () => parseCommand([
      'configure',
      '--state-dir',
      '/private/state',
      '--operations',
      'file.read',
      '--tools',
      'git',
      '--clear-tools',
    ]),
    /Usage/,
  )
})
