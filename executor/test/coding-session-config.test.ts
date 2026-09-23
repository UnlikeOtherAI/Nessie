import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  canonicalCodingSessionsConfig,
  CodingSessionConfigError,
  codingSessionsConfigDigest,
  codingSessionsDigestMatches,
  loadCodingSessionsConfig,
  normalizeCodingSessionsConfig,
} from '../src/coding-session/config.js'
import { normalizeCodingPath, resolveCodingFolder, resolveCodingRoots } from '../src/coding-session/roots.js'

const minimal = (overrides: Record<string, unknown> = {}) => ({
  codingSessions: {
    roots: [{ name: 'nessie', path: join(tmpdir(), 'nessie-root') }],
    agents: { claude: { command: ['/usr/local/bin/claude'] } },
    ...overrides,
  },
})

test('defaults are filled in, so the digest covers what actually runs', () => {
  const config = normalizeCodingSessionsConfig(minimal())
  assert.equal(config.maxLiveSessionsPerOwner, 3)
  assert.equal(config.idleMinutes, 30)
  assert.equal(config.maxTurnMinutes, 45)
  assert.equal(config.maxBudgetUsd, undefined)
  assert.deepEqual(config.agentEnv, { inheritUserSession: true, pass: [], set: {} })
  assert.deepEqual(config.agents.claude, { command: ['/usr/local/bin/claude'], args: [], allowedTools: [], disallowedTools: [] })
})

test('the digest is canonical: key order does not matter, any power change does', () => {
  const one = normalizeCodingSessionsConfig(minimal({ maxBudgetUsd: 20, idleMinutes: 10 }))
  const two = normalizeCodingSessionsConfig({ codingSessions: {
    idleMinutes: 10, maxBudgetUsd: 20,
    agents: { claude: { command: ['/usr/local/bin/claude'] } },
    roots: [{ path: join(tmpdir(), 'nessie-root'), name: 'nessie' }],
  } })
  assert.equal(canonicalCodingSessionsConfig(one), canonicalCodingSessionsConfig(two))
  assert.match(codingSessionsConfigDigest(one), /^sha256:[0-9a-f]{64}$/u)
  assert.equal(codingSessionsConfigDigest(one), codingSessionsConfigDigest(two))
  const wider = normalizeCodingSessionsConfig(minimal({
    maxBudgetUsd: 20, idleMinutes: 10,
    agents: { claude: { command: ['/usr/local/bin/claude'], permissionMode: 'bypassPermissions' } },
  }))
  assert.notEqual(codingSessionsConfigDigest(wider), codingSessionsConfigDigest(one))
})

test('an unknown key, an unknown mode or a Claude-only field on Codex is refused rather than ignored', () => {
  const refuses = (input: unknown, pattern: RegExp) => assert.throws(
    () => normalizeCodingSessionsConfig(input),
    (error: unknown) => error instanceof CodingSessionConfigError && pattern.test(error.message),
  )
  refuses(minimal({ permissionPrompts: 'relay' }), /unknown keys: permissionPrompts/u)
  refuses(minimal({ agents: { claude: { command: ['c'], permissionMode: 'yolo' } } }), /permissionMode must be one of/u)
  refuses(minimal({ agents: { codex: { command: ['c'], allowedTools: ['Bash'] } } }), /unknown keys: allowedTools/u)
  refuses(minimal({ agents: { cursor: { command: ['c'] } } }), /unknown keys: cursor/u)
  refuses(minimal({ agents: {} }), /at least one coding agent/u)
  refuses(minimal({ roots: [{ name: 'Bad Name', path: '/x' }] }), /lowercase letters/u)
  refuses(minimal({ roots: [{ name: 'a', path: 'relative' }] }), /absolute directory/u)
  refuses(minimal({ roots: [{ name: 'a', path: '/x' }, { name: 'a', path: '/y' }] }), /unique/u)
  refuses(minimal({ maxLiveSessionsPerOwner: 1.5 }), /maxLiveSessionsPerOwner/u)
  refuses(minimal({ agentEnv: { pass: ['NOT-A-NAME'] } }), /names environment variables/u)
  refuses({ codingSessions: minimal().codingSessions, other: true }, /unknown keys: other/u)
})

test('flags that carry power the review would not show are refused in args and command alike', () => {
  const refuses = (agents: Record<string, unknown>, pattern: RegExp) => assert.throws(
    () => normalizeCodingSessionsConfig(minimal({ agents })),
    (error: unknown) => error instanceof CodingSessionConfigError && pattern.test(error.message),
    JSON.stringify(agents),
  )
  for (const args of [
    ['--dangerously-skip-permissions'], ['--allow-dangerously-skip-permissions'], ['--permission-mode', 'bypassPermissions'],
    ['--permission-mode=bypassPermissions'], ['--add-dir', 'C:/'], ['--allowedTools', 'Bash'], ['--allowed-tools=Bash'],
    ['--disallowedTools', 'Read'], ['--settings', '{"permissions":{}}'], ['--setting-sources', 'user'], ['--mcp-config', 'x.json'],
    ['--permission-prompts', 'host'], ['--permission-prompt-tool', 'stdio'], ['--resume', 'x'], ['-p'],
  ]) {
    refuses({ claude: { command: ['/usr/local/bin/claude'], args } }, new RegExp(`may not pass ${args[0]!.split('=')[0]}`, 'u'))
  }
  refuses({ claude: { command: ['/usr/bin/node', 'cli.js', '--dangerously-skip-permissions'] } }, /may not pass/u)
  for (const args of [
    ['-c', 'sandbox_mode="danger-full-access"'], ['--config=approval_policy="never"'], ['-capproval_policy=never'],
    ['--profile', 'wide'], ['--add-dir', '/'], ['-C', '/'], ['--enable', 'x'], ['--dangerously-bypass-hook-trust'],
  ]) {
    refuses({ codex: { command: ['/usr/bin/node', 'codex.js'], args } }, /may not pass -/u)
  }
  refuses({ codex: { command: ['/usr/bin/node', 'codex.js'], args: ['resume'] } }, /may not name the resume subcommand/u)
  refuses({ claude: { command: ['C:/Users/o/AppData/Roaming/npm/claude.cmd'] } }, /script shim; name the program itself \(claude\.exe\)/u)
  refuses({ codex: { command: ['C:/npm/codex.PS1'] } }, /script shim/u)
  // What the reviewed fields already say, or what carries no power, still passes.
  const fine = normalizeCodingSessionsConfig(minimal({ agents: {
    claude: { command: ['/usr/local/bin/claude'], args: ['--effort', 'high', '--strict-mcp-config'] },
    codex: { command: ['/usr/bin/node', 'codex.js'], args: ['--sandbox', 'workspace-write', '--skip-git-repo-check'] },
  } }))
  assert.deepEqual(fine.agents.codex?.args, ['--sandbox', 'workspace-write', '--skip-git-repo-check'])
})

test('a reviewed digest that differs from the file stops hosts; no digest at all is a hand-run bridge', () => {
  const digest = codingSessionsConfigDigest(normalizeCodingSessionsConfig(minimal()))
  assert.equal(codingSessionsDigestMatches({ digest }, {}), true)
  assert.equal(codingSessionsDigestMatches({ digest }, { NESSIE_CODING_SESSIONS_CONFIG_DIGEST: digest }), true)
  assert.equal(codingSessionsDigestMatches({ digest }, { NESSIE_CODING_SESSIONS_CONFIG_DIGEST: `sha256:${'1'.repeat(64)}` }), false)
})

test('roots are refused when they overlap the state or the config file, or each other', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'nessie-coding-config-')))
  try {
    const work = join(dir, 'work')
    const other = join(dir, 'other')
    await mkdir(join(work, 'src'), { recursive: true })
    await mkdir(other)
    const configPath = join(dir, 'config', 'coding-sessions.json')
    await mkdir(join(dir, 'config'))
    const write = async (roots: unknown) => {
      await writeFile(configPath, JSON.stringify({ codingSessions: { roots, agents: { claude: { command: ['claude'] } } } }))
      return loadCodingSessionsConfig(configPath)
    }
    const loaded = await write([{ name: 'work', path: work }, { name: 'other', path: other }])
    assert.equal(loaded.stateDir, join(dir, 'config', 'coding-sessions'))
    const set = await resolveCodingRoots(loaded)
    assert.deepEqual(set.roots.map((root) => [root.name, root.canonical]), [['work', work], ['other', other]])
    assert.equal(await resolveCodingFolder(set.roots[0]!, normalizeCodingPath('src')), join(work, 'src'))
    await assert.rejects(resolveCodingFolder(set.roots[0]!, normalizeCodingPath('missing')), /existing folder/u)
    assert.throws(() => normalizeCodingPath('../other'), /relative folder/u)
    assert.throws(() => normalizeCodingPath(work), /relative folder/u)
    await assert.rejects(resolveCodingRoots(await write([{ name: 'all', path: dir }])), /overlaps the coding-sessions state/u)
    await assert.rejects(
      resolveCodingRoots(await write([{ name: 'config', path: join(dir, 'config') }])), /overlaps the coding-sessions state/u,
    )
    await assert.rejects(
      resolveCodingRoots(await write([{ name: 'work', path: work }, { name: 'src', path: join(work, 'src') }])), /overlap/u,
    )
    const spelled = process.platform === 'win32' ? dir.toUpperCase() : dir
    if (process.platform === 'win32') {
      await assert.rejects(resolveCodingRoots(await write([{ name: 'upper', path: spelled }])), /overlaps/u)
    }
    const missing = await resolveCodingRoots(await write([{ name: 'gone', path: join(dir, 'unplugged') }]))
    assert.equal(missing.roots[0]!.canonical, undefined)
    await assert.rejects(resolveCodingFolder(missing.roots[0]!, '.'), /not available/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the config path must be absolute and an ordinary file', async () => {
  await assert.rejects(loadCodingSessionsConfig('relative.json'), /must be absolute/u)
  await assert.rejects(loadCodingSessionsConfig(join(tmpdir(), 'nessie-no-such-config.json')), /ordinary file/u)
})
