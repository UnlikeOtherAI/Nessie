import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME, ExecutorCapabilityDescriptorSchema } from '@nessie/schemas'

import { CODING_SESSIONS_CONFIG_DIGEST_ENV, loadCodingSessionsConfig } from '../src/coding-session/config.js'
import { codingPathsOverlap } from '../src/coding-session/roots.js'
import {
  codingSessionsConfigPath,
  codingSessionsStateIsConsistent,
  isBuiltinCodingSessionsServer,
  planCodingSessions,
  type ExecutorRuntime,
} from '../src/coding-sessions-policy.js'
import { parseConfigurationInput } from '../src/configuration-input.js'
import { buildSignedDescriptor } from '../src/descriptor.js'
import { describeExecutor } from '../src/describe.js'
import type { ExecutorHost } from '../src/host-platform.js'
import { configureExecutorLocalPolicy } from '../src/pair.js'
import { loadExecutorState, saveExecutorState, type ExecutorLocalState } from '../src/state-store.js'

/**
 * The executor side of coding-sessions.md §4: the owner's `codingSessions`
 * object becomes an owner-only host-local file, a named server the executor
 * generates itself, and power facts inside the signed descriptor. Roots may
 * not overlap anything a coding agent must never write.
 */

const runtime: ExecutorRuntime = {
  entry: '/opt/nessie/nessie-executor.cjs', execArgv: [], execPath: '/opt/nessie/node', packaged: true,
}

const noSandboxHost: ExecutorHost = {
  platform: { architecture: 'arm64', os: 'macos', osMajorVersion: 15 },
  sandboxBackend: 'none',
  supervisor: 'desktop',
}

type Scratch = { dir: string; stateDir: string; root: string; folder: string }

const scratch = async (): Promise<Scratch> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'nessie-coding-policy-')))
  const scratchDirs = { dir, stateDir: join(dir, 'state'), root: join(dir, 'projects', 'nessie'), folder: join(dir, 'docs') }
  for (const path of [scratchDirs.stateDir, scratchDirs.root, scratchDirs.folder]) await mkdir(path, { recursive: true })
  return scratchDirs
}

const request = (root: string, extra: Record<string, unknown> = {}) => ({
  roots: [{ name: 'nessie', path: root }],
  agents: {
    claude: { command: ['/usr/local/bin/claude'], permissionMode: 'acceptEdits', allowedTools: ['Bash(git *)', 'Bash(pnpm *)', 'Bash(gh *)'] },
    codex: { command: ['node', '/opt/codex.js'], args: ['--dangerously-bypass-approvals-and-sandbox'] },
  },
  ...extra,
})

const writes = () => {
  const written: { path: string; value: unknown }[] = []
  return { written, writeConfig: async (path: string, value: unknown) => { written.push({ path, value }) } }
}

test('configure generates the bridge entry itself and states its power facts', async () => {
  const s = await scratch()
  try {
    const { written, writeConfig } = writes()
    const plan = await planCodingSessions({
      requested: request(s.root), runtime, writeConfig,
      current: {}, mcpServers: [{ name: 'kelpie', command: ['kelpie', 'mcp'] }],
      stateDir: s.stateDir, workspaceFolders: [{ name: 'docs', path: s.folder }],
    })
    const configPath = codingSessionsConfigPath(s.stateDir)
    const bridge = plan.servers.find((server) => server.name === EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME)!
    assert.deepEqual(plan.servers.map((server) => server.name), ['kelpie', 'coding-sessions'])
    assert.deepEqual(bridge.command, ['/opt/nessie/node', '/opt/nessie/nessie-executor.cjs', 'serve-coding-session-mcp', '--config', configPath])
    assert.deepEqual(bridge.env, { [CODING_SESSIONS_CONFIG_DIGEST_ENV]: plan.facts!.configDigest, NESSIE_EXECUTOR_PACKAGED_CLI: '1' })
    assert.equal(isBuiltinCodingSessionsServer(bridge), true)
    assert.deepEqual({ ...plan.facts, configDigest: 'x' }, {
      serverName: 'coding-sessions',
      agents: ['claude', 'codex'],
      permissionMode: { claude: 'acceptEdits', codex: 'bypassApprovalsAndSandbox' },
      allowedToolCount: 3,
      rootNames: ['nessie'],
      configDigest: 'x',
    })
    assert.deepEqual(written, [], 'nothing is written before the whole policy is accepted')
    await assert.rejects(plan.persist(['file.read']), /enable both to offer them/u)
    assert.deepEqual(written, [])
    await plan.persist(['mcp.tools', 'mcp.call'])
    assert.equal(written[0]?.path, configPath)
    // The bridge loading that file computes exactly the digest the daemon will pass it.
    await writeFile(configPath, JSON.stringify(written[0]!.value))
    assert.equal((await loadCodingSessionsConfig(configPath)).digest, plan.facts!.configDigest)
  } finally {
    await rm(s.dir, { recursive: true, force: true })
  }
})

test('a root may not overlap a workspace folder, executor state, bridge state or the config file', async () => {
  const s = await scratch()
  try {
    const refuse = async (root: string, pattern: RegExp, folders = [{ name: 'docs', path: s.folder }]) => {
      await assert.rejects(planCodingSessions({
        requested: request(root), runtime, current: {}, mcpServers: [], stateDir: s.stateDir, workspaceFolders: folders,
      }), pattern)
    }
    await refuse(s.folder, /overlaps the workspace folder "docs"/u)
    await mkdir(join(s.folder, 'inner'))
    await refuse(join(s.folder, 'inner'), /overlaps the workspace folder "docs"/u)
    await refuse(s.dir, /overlaps/u, [])
    await refuse(s.stateDir, /overlaps the coding-sessions state/u)
    await mkdir(join(s.stateDir, 'coding-sessions', 'sessions'), { recursive: true })
    await refuse(join(s.stateDir, 'coding-sessions', 'sessions'), /overlaps the coding-sessions state/u)
    await refuse(join(s.dir, 'missing'), /must be an existing ordinary directory/u)
    if (process.platform === 'win32' || process.platform === 'darwin') {
      // The filesystem folds case, so the refusal does too.
      await refuse(s.folder.toUpperCase(), /overlaps the workspace folder "docs"/u)
    }
  } finally {
    await rm(s.dir, { recursive: true, force: true })
  }
})

test('overlap compares names the way the host does', () => {
  assert.equal(codingPathsOverlap('/Users/Person/Code', '/users/person/code/nessie', 'darwin'), true)
  assert.equal(codingPathsOverlap('/home/p/code', '/home/p/code-two', 'linux'), false)
  // Node's own path arithmetic folds case on a Windows host whatever is asked of it.
  if (process.platform !== 'win32') {
    assert.equal(codingPathsOverlap('/Users/Person/Code', '/users/person/code/nessie', 'linux'), false)
  }
})

test('the name coding-sessions is the executor\'s; nobody may point it at a program', async () => {
  const s = await scratch()
  try {
    await assert.rejects(planCodingSessions({
      current: {}, mcpServers: [{ name: 'coding-sessions', command: ['/tmp/anything'] }],
      stateDir: s.stateDir, workspaceFolders: [],
    }), /reserved for the executor's own bridge/u)
  } finally {
    await rm(s.dir, { recursive: true, force: true })
  }
})

test('absent keeps the reviewed bridge, null withdraws it, and a kept root is checked against new folders', async () => {
  const s = await scratch()
  try {
    const configured = await planCodingSessions({
      requested: request(s.root), runtime, current: {}, mcpServers: [], stateDir: s.stateDir, workspaceFolders: [],
      writeConfig: async (path, value) => { await writeFile(path, JSON.stringify(value)) },
    })
    await configured.persist(['mcp.tools', 'mcp.call'])
    const current = { facts: configured.facts!, servers: configured.servers }
    const kept = await planCodingSessions({ current, mcpServers: configured.servers, stateDir: s.stateDir, workspaceFolders: [] })
    assert.deepEqual(kept.facts, configured.facts)
    assert.deepEqual(kept.servers, configured.servers, 'the generated entry round-trips unchanged')
    const withdrawn = await planCodingSessions({
      requested: null, current, mcpServers: configured.servers, stateDir: s.stateDir, workspaceFolders: [],
    })
    assert.equal(withdrawn.facts, undefined)
    assert.deepEqual(withdrawn.servers, [])
    await assert.rejects(planCodingSessions({
      current, mcpServers: configured.servers, stateDir: s.stateDir,
      workspaceFolders: [{ name: 'projects', path: join(s.dir, 'projects') }],
    }), /overlaps the workspace folder "projects"/u)
  } finally {
    await rm(s.dir, { recursive: true, force: true })
  }
})

test('a state whose bridge entry and facts disagree is malformed', async () => {
  const s = await scratch()
  try {
    const plan = await planCodingSessions({
      requested: request(s.root), runtime, current: {}, mcpServers: [], stateDir: s.stateDir, workspaceFolders: [],
    })
    const [bridge] = plan.servers
    assert.equal(codingSessionsStateIsConsistent(plan.facts, plan.servers), true)
    assert.equal(codingSessionsStateIsConsistent(undefined, undefined), true)
    assert.equal(codingSessionsStateIsConsistent(plan.facts, []), false)
    assert.equal(codingSessionsStateIsConsistent(undefined, plan.servers), false)
    assert.equal(codingSessionsStateIsConsistent({ ...plan.facts!, configDigest: `sha256:${'0'.repeat(64)}` }, plan.servers), false)
    assert.equal(codingSessionsStateIsConsistent(plan.facts, [{ ...bridge!, command: ['/tmp/imposter'] }]), false)
  } finally {
    await rm(s.dir, { recursive: true, force: true })
  }
})

test('the facts are part of the signed descriptor and of its policy digest', async () => {
  const s = await scratch()
  try {
    const plan = await planCodingSessions({
      requested: request(s.root), runtime, current: {}, mcpServers: [], stateDir: s.stateDir, workspaceFolders: [],
    })
    const wider = await planCodingSessions({
      requested: request(s.root, { maxBudgetUsd: 500 }), runtime, current: {}, mcpServers: [], stateDir: s.stateDir, workspaceFolders: [],
    })
    const key = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
    const policy = (facts: typeof plan.facts) => ({
      codingSessions: facts!,
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      mcpServers: ['coding-sessions'],
      operationKeys: ['file.read', 'mcp.tools', 'mcp.call'],
      profiles: ['workspace_sandbox'],
      revision: 2,
    })
    const signed = buildSignedDescriptor(key, policy(plan.facts), noSandboxHost)
    assert.deepEqual(ExecutorCapabilityDescriptorSchema.parse(signed.descriptor).codingSessions, plan.facts)
    const widened = buildSignedDescriptor(key, policy(wider.facts), noSandboxHost)
    // Only the budget changed, which no fact names — the config digest carries it into review.
    assert.notEqual(widened.descriptor.localPolicyDigest, signed.descriptor.localPolicyDigest)
    assert.equal(JSON.stringify(signed).includes(s.root), false, 'no root path travels in the descriptor')
  } finally {
    await rm(s.dir, { recursive: true, force: true })
  }
})

test('the configuration input carries codingSessions as an object, or null to withdraw it', () => {
  const base = { operationKeys: ['mcp.tools', 'mcp.call'], workspaceFolders: [{ name: 'docs', path: '/docs' }] }
  assert.deepEqual(parseConfigurationInput(JSON.stringify({ ...base, codingSessions: { roots: [] } })).codingSessions, { roots: [] })
  assert.equal(parseConfigurationInput(JSON.stringify({ ...base, codingSessions: null })).codingSessions, null)
  assert.equal('codingSessions' in parseConfigurationInput(JSON.stringify(base)), false)
  for (const bad of [[], 'claude', 3]) {
    assert.throws(() => parseConfigurationInput(JSON.stringify({ ...base, codingSessions: bad })), /malformed/u)
  }
})

test('configure saves the bridge, the state loads it back, and describe states it', {
  // Saving executor state on Windows needs the packaged native helper.
  skip: process.platform === 'win32' ? 'executor state on Windows needs the packaged native helper' : false,
}, async () => {
  const s = await scratch()
  try {
    const state: ExecutorLocalState = {
      apiBaseUrl: 'https://api.example.test',
      descriptor: {
        limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
        operationKeys: ['file.read'], profiles: ['workspace_sandbox'], revision: 1, workspaceFolders: ['docs'],
      },
      executorId: '00000000-0000-4000-8000-000000000601',
      machinePrivateKey: 'private', machinePublicKey: 'public',
      workspaceFolders: [{ name: 'docs', path: s.folder }],
    }
    await saveExecutorState(s.stateDir, state)
    const updated = await configureExecutorLocalPolicy(
      s.stateDir, state, ['file.read', 'mcp.tools', 'mcp.call'], undefined, noSandboxHost,
      state.workspaceFolders, undefined, undefined, { requested: request(s.root), runtime },
    )
    assert.deepEqual(updated.descriptor.mcpServers, ['coding-sessions'])
    assert.equal(updated.descriptor.codingSessions?.rootNames[0], 'nessie')
    const configPath = codingSessionsConfigPath(s.stateDir)
    assert.equal((await stat(configPath)).mode & 0o077, 0, 'the host-local config is owner-only')
    assert.equal((await loadCodingSessionsConfig(configPath)).digest, updated.descriptor.codingSessions?.configDigest)
    const loaded = await loadExecutorState(s.stateDir)
    assert.deepEqual(loaded.descriptor.codingSessions, updated.descriptor.codingSessions)
    const described = describeExecutor(loaded)
    assert.deepEqual(described.policy.codingSessions, updated.descriptor.codingSessions)
    assert.equal(described.reach.codingSessionsConfig, configPath)
    const persisted = JSON.parse(await readFile(join(s.stateDir, 'executor-state.json'), 'utf8')) as ExecutorLocalState
    assert.equal(persisted.mcpServers?.[0]?.env?.[CODING_SESSIONS_CONFIG_DIGEST_ENV], updated.descriptor.codingSessions?.configDigest)
  } finally {
    await rm(s.dir, { recursive: true, force: true })
  }
})
