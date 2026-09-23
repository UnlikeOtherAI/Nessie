import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  checkAgentCapabilities,
  parseHelpText,
  readAgentCapabilities,
  type AgentCapabilities,
} from '../src/coding-session/agent-capabilities.js'
import { runCommand, type CommandRunner } from '../src/coding-session/agent-env.js'
import type { CodingAgentConfig } from '../src/coding-session/config.js'

/**
 * What an installed coding CLI offers, proved against the help texts captured
 * from claude 2.1.280 and codex-cli 0.155.1. `claude-older.txt` is the 2.1.280
 * text with the `--permission-prompts` option taken out, standing in for a
 * CLI from before that flag existed.
 */

const helpText = (name: string): string => readFileSync(new URL(`./fixtures/agent-help/${name}`, import.meta.url), 'utf8')
const CLAUDE = parseHelpText(helpText('claude-2.1.280.txt'))
const OLDER = parseHelpText(helpText('claude-older.txt'))
const CODEX = { exec: parseHelpText(helpText('codex-0.155.1-exec.txt')), 'exec resume': parseHelpText(helpText('codex-0.155.1-exec-resume.txt')) }

const agent = (overrides: Partial<CodingAgentConfig> = {}): CodingAgentConfig => ({
  command: ['/opt/claude'], args: [], allowedTools: [], disallowedTools: [], ...overrides,
})

test('a commander help yields its option names and choices, not the flags its descriptions mention', () => {
  for (const flag of ['-p', '--print', '--input-format', '--output-format', '--verbose', '--replay-user-messages', '--session-id',
    '-r', '--resume', '--permission-prompts', '--permission-mode', '--allowedTools', '--allowed-tools', '--disallowedTools',
    '--model', '--max-budget-usd', '--append-system-prompt']) {
    assert.ok(CLAUDE.flags.includes(flag), flag)
  }
  // Named only inside other options' descriptions in 2.1.280.
  for (const flag of ['--permission-prompt-tool', '--system-prompt-file', '--append-system-prompt-file']) {
    assert.equal(CLAUDE.flags.includes(flag), false, flag)
  }
  assert.deepEqual(CLAUDE.choices['--permission-mode'], ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'])
  assert.deepEqual(CLAUDE.choices['--permission-prompts'], ['host', 'none'], 'the default is not a choice of its own')
  assert.deepEqual(CLAUDE.choices['--input-format'], ['text', 'stream-json'])
  assert.match(CLAUDE.usage, /^Usage: claude /u)
  assert.equal(OLDER.flags.includes('--permission-prompts'), false)
  assert.ok(CODEX.exec.flags.includes('-C') && CODEX.exec.flags.includes('--json') && CODEX.exec.flags.includes('-m'))
  assert.ok(CODEX['exec resume'].flags.includes('--json'))
})

test('Claude Code 2.1.280 offers every flag the adapter passes, the optional ones included', () => {
  const full = agent({
    permissionMode: 'acceptEdits', allowedTools: ['Bash(git *)'], disallowedTools: ['WebFetch'], model: 'haiku', args: ['--effort', 'high'],
  })
  assert.deepEqual(checkAgentCapabilities({ agent: 'claude', config: full, capabilities: { '': CLAUDE }, maxBudgetUsd: 2 }), { ok: true })
})

test('a flag the CLI does not list refuses the start as agent_outdated, naming what was missing', () => {
  assert.deepEqual(checkAgentCapabilities({ agent: 'claude', config: agent(), capabilities: { '': OLDER } }), {
    ok: false, reason: 'agent_outdated', missing: ['--permission-prompts'],
  })
  // An optional flag is required only once the configuration turns it on.
  const withoutBudget: AgentCapabilities = { '': { ...CLAUDE, flags: CLAUDE.flags.filter((flag) => flag !== '--max-budget-usd') } }
  assert.deepEqual(checkAgentCapabilities({ agent: 'claude', config: agent(), capabilities: withoutBudget }), { ok: true })
  assert.deepEqual(checkAgentCapabilities({ agent: 'claude', config: agent(), capabilities: withoutBudget, maxBudgetUsd: 5 }), {
    ok: false, reason: 'agent_outdated', missing: ['--max-budget-usd'],
  })
  assert.deepEqual(checkAgentCapabilities({ agent: 'claude', config: agent({ args: ['--frobnicate=on'] }), capabilities: { '': CLAUDE } }), {
    ok: false, reason: 'agent_outdated', missing: ['--frobnicate'],
  })
  assert.deepEqual(checkAgentCapabilities({ agent: 'claude', config: agent(), capabilities: {} }), {
    ok: false, reason: 'agent_outdated', missing: ['--help'],
  })
})

test('the permission mode is checked against the choices this CLI lists, not a list of our own', () => {
  const check = (permissionMode: string, capabilities: AgentCapabilities = { '': CLAUDE }) => (
    checkAgentCapabilities({ agent: 'claude', config: agent({ permissionMode }), capabilities })
  )
  assert.deepEqual(check('manual'), { ok: true })
  assert.deepEqual(check('default'), { ok: false, reason: 'permission_mode_unsupported', missing: ['--permission-mode default'] })
  const newer = parseHelpText(helpText('claude-2.1.280.txt').replace('"dontAsk", "plan")', '"dontAsk", "plan", "review")'))
  assert.deepEqual(check('review'), { ok: false, reason: 'permission_mode_unsupported', missing: ['--permission-mode review'] })
  assert.deepEqual(check('review', { '': newer }), { ok: true }, 'a mode a newer CLI adds needs no executor release')
})

test('Codex needs exec, exec resume, and each flag where the subcommand that parses it lists it', () => {
  const codex = agent({ command: ['node', '/opt/codex.js'], args: ['--sandbox', 'workspace-write'], model: 'gpt-5' })
  assert.deepEqual(checkAgentCapabilities({ agent: 'codex', config: codex, capabilities: CODEX }), { ok: true })
  // 0.155.1 lists no --full-auto on exec, so a configuration still passing it would fail on its first turn.
  assert.deepEqual(checkAgentCapabilities({ agent: 'codex', config: agent({ command: ['codex'], args: ['--full-auto'] }), capabilities: CODEX }), {
    ok: false, reason: 'agent_outdated', missing: ['--full-auto'],
  })
  // A codex without `exec resume` answers `exec resume --help` with the exec help itself.
  assert.deepEqual(checkAgentCapabilities({ agent: 'codex', config: codex, capabilities: { exec: CODEX.exec, 'exec resume': CODEX.exec } }), {
    ok: false, reason: 'agent_outdated', missing: ['exec resume'],
  })
  const noJson = { ...CODEX, 'exec resume': { ...CODEX['exec resume'], flags: CODEX['exec resume'].flags.filter((flag) => flag !== '--json') } }
  assert.deepEqual(checkAgentCapabilities({ agent: 'codex', config: codex, capabilities: noJson }), {
    ok: false, reason: 'agent_outdated', missing: ['--json'],
  })
})

test('help is read once per program path and modification time, and a failed read is not remembered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-agent-help-'))
  try {
    // Found through the agent's PATH the way its spawn finds it: `claude` on POSIX, `claude.exe` on Windows.
    await writeFile(join(dir, 'claude'), 'x')
    await writeFile(join(dir, 'claude.exe'), 'x')
    const cacheFile = join(dir, 'agent-help.json')
    const calls: { args: string[]; timeoutMs: number | undefined; maxBytes: number | undefined }[] = []
    let answer = { code: 0 as number | null, missing: false, stdout: helpText('claude-2.1.280.txt') }
    const run: CommandRunner = async (_file, args, options) => {
      calls.push({ args, timeoutMs: options?.timeoutMs, maxBytes: options?.maxBytes })
      return answer
    }
    const read = () => readAgentCapabilities({ agent: 'claude', command: ['claude'], cwd: dir, env: { PATH: dir }, run, cacheFile })
    assert.deepEqual((await read())['']?.choices['--permission-mode']?.length, 6)
    assert.deepEqual(calls, [{ args: ['--help'], timeoutMs: 15_000, maxBytes: 262_144 }], 'bounded in time and size')
    await read()
    assert.equal(calls.length, 1, 'an unchanged CLI is read once')
    const later = new Date(Date.now() + 60_000)
    for (const name of ['claude', 'claude.exe']) await utimes(join(dir, name), later, later)
    answer = { code: null, missing: false, stdout: '' }
    assert.deepEqual(await read(), {}, 'an updated CLI is read afresh')
    assert.equal(calls.length, 2)
    answer = { code: 0, missing: false, stdout: helpText('claude-older.txt') }
    assert.equal((await read())['']?.flags.includes('--permission-prompts'), false, 'the failed read was not cached')
    assert.equal(calls.length, 3)
    await read()
    assert.equal(calls.length, 3)
    const cached = JSON.parse(await readFile(cacheFile, 'utf8')) as { entries: unknown[] }
    assert.equal(cached.entries.length, 2, 'one entry per program stamp')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a command that runs too long or prints too much answers with no exit code', async () => {
  const flood = await runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(200000))'], { maxBytes: 1_000 })
  assert.equal(flood.code, null)
  const slow = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 300 })
  assert.equal(slow.code, null)
})
