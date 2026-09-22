import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildAgentEnvironment,
  captureUserSessionEnvironment,
  parseLoginEnvironment,
  parseRegistryEnvironment,
  parseSystemdEnvironment,
  type CommandRunner,
} from '../src/coding-session/agent-env.js'
import { runCodingSelfCheck } from '../src/coding-session/self-check.js'

/**
 * The agent's environment per OS, with each OS's source faked by the command
 * runner so all three arms run on any host. The subprocess suite covers the
 * real capture on the machine it runs on.
 */

const MACHINE = [
  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  '    ComSpec    REG_EXPAND_SZ    %SystemRoot%\\system32\\cmd.exe',
  '    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;C:\\Program Files\\Git\\cmd',
  '    PATHEXT    REG_SZ    .COM;.EXE;.BAT;.CMD',
  '    TEMP    REG_EXPAND_SZ    %SystemRoot%\\TEMP',
  '    USERNAME    REG_SZ    SYSTEM',
  '    windir    REG_EXPAND_SZ    %SystemRoot%',
  '    EMPTY    REG_SZ    ',
  '',
].join('\r\n')
const USER = [
  'HKEY_CURRENT_USER\\Environment',
  '    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Roaming\\npm',
  '    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp',
  '    TMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp',
  '    GOPATH    REG_EXPAND_SZ    %USERPROFILE%\\go',
  '',
].join('\r\n')

type Answer = { code?: number | null; missing?: boolean; stdout?: string }

const runner = (answers: Record<string, Answer>): CommandRunner => (
  async (file, args) => {
    const key = [file.replaceAll('\\', '/').split('/').pop(), ...args].join(' ')
    const answer = Object.entries(answers).find(([prefix]) => key.startsWith(prefix))?.[1]
    return { code: answer?.code === undefined ? 0 : answer.code, missing: answer?.missing ?? false, stdout: answer?.stdout ?? '' }
  }
)

test('registry values are read with their types, including empty ones', () => {
  assert.deepEqual(parseRegistryEnvironment(MACHINE).slice(0, 2), [
    { name: 'ComSpec', type: 'REG_EXPAND_SZ', value: '%SystemRoot%\\system32\\cmd.exe' },
    { name: 'Path', type: 'REG_EXPAND_SZ', value: '%SystemRoot%\\system32;C:\\Program Files\\Git\\cmd' },
  ])
  assert.deepEqual(parseRegistryEnvironment(MACHINE).find((entry) => entry.name === 'EMPTY'), { name: 'EMPTY', type: 'REG_SZ', value: '' })
})

test('Windows: machine then user, Path joined, the logon\'s USERNAME kept, names case-insensitive', async () => {
  const env = await captureUserSessionEnvironment('win32', {
    SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\ondre', USERNAME: 'ondre', PATH: 'C:\\minimal', SystemDrive: 'C:',
  }, runner({ 'reg.exe query HKLM': { stdout: MACHINE }, 'reg.exe query HKCU': { stdout: USER } }))
  assert.equal(env.ComSpec, 'C:\\Windows\\system32\\cmd.exe')
  assert.equal(env.PATH, 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd;C:\\Users\\ondre\\AppData\\Roaming\\npm')
  assert.equal(Object.keys(env).filter((name) => name.toUpperCase() === 'PATH').length, 1)
  assert.equal(env.USERNAME, 'ondre')
  assert.equal(env.TEMP, 'C:\\Users\\ondre\\AppData\\Local\\Temp')
  assert.equal(env.GOPATH, 'C:\\Users\\ondre\\go')
  assert.equal(env.windir, 'C:\\Windows')
  assert.equal(env.ProgramData, 'C:\\ProgramData')
})

test('macOS: launchctl supplies the agent socket, the login shell the rest, past a noisy profile', async () => {
  const login = `Last login: today\nwelcome!\n__NESSIE_LOGIN_ENVIRONMENT__\0LANG=en_GB.UTF-8\0PATH=/opt/homebrew/bin:/usr/bin\0BAD NAME=x\0MULTI=a\nb\0`
  const env = await captureUserSessionEnvironment('darwin', { HOME: '/Users/ondre', SHELL: '/bin/zsh', PATH: '/usr/bin' }, runner({
    'launchctl getenv SSH_AUTH_SOCK': { stdout: '/private/tmp/com.apple.launchd.x/Listeners\n' },
    'launchctl getenv TMPDIR': { stdout: '' },
    'zsh -lc': { stdout: login },
  }))
  assert.equal(env.SSH_AUTH_SOCK, '/private/tmp/com.apple.launchd.x/Listeners')
  assert.equal(env.LANG, 'en_GB.UTF-8')
  assert.equal(env.PATH, '/opt/homebrew/bin:/usr/bin')
  assert.equal(env.MULTI, 'a\nb')
  assert.equal(env['BAD NAME'], undefined)
  assert.equal(env.TMPDIR, undefined)
  assert.deepEqual(parseLoginEnvironment('no marker at all'), {})
})

test('Linux: the systemd user manager, then the login shell', async () => {
  assert.deepEqual(parseSystemdEnvironment("LANG=C.UTF-8\nQUOTED=$'a\\nb'\n=broken\n"), { LANG: 'C.UTF-8', QUOTED: 'a\nb' })
  const env = await captureUserSessionEnvironment('linux', { HOME: '/home/ondre', SHELL: '/bin/bash', PATH: '/usr/bin' }, runner({
    'systemctl --user show-environment': { stdout: 'SSH_AUTH_SOCK=/run/user/1000/keyring/ssh\nLANG=C.UTF-8\n' },
    'bash -lc': { stdout: '__NESSIE_LOGIN_ENVIRONMENT__\0LANG=en_US.UTF-8\0' },
  }))
  assert.equal(env.SSH_AUTH_SOCK, '/run/user/1000/keyring/ssh')
  assert.equal(env.LANG, 'en_US.UTF-8', 'the login shell has the last word')
})

test('only the parent-session coupling and the executor markers are stripped; pass and set apply after', async () => {
  const env = await buildAgentEnvironment({
    platform: 'linux',
    config: { inheritUserSession: false, pass: ['FORWARD_ME', 'ABSENT'], set: { EXTRA: '1' } },
    received: {
      PATH: '/usr/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '1', CLAUDE_CODE_MESSAGING_SOCKET: '/s',
      CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1', CLAUDE_CODE_GIT_BASH_PATH: '/bash', NESSIE_EXECUTOR_PACKAGED_CLI: '1',
      NESSIE_CODING_SESSIONS_CONFIG_DIGEST: 'sha256:x', FORWARD_ME: 'yes',
    },
  })
  assert.deepEqual(env, {
    PATH: '/usr/bin', CLAUDE_CODE_GIT_BASH_PATH: '/bash', FORWARD_ME: 'yes', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', EXTRA: '1',
  })
  const overridden = await buildAgentEnvironment({
    platform: 'win32', config: { inheritUserSession: false, pass: [], set: { claude_code_disable_auto_memory: '0' } }, received: {},
  })
  assert.deepEqual(overridden, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' }, 'set may turn auto-memory back on')
})

test('the self-check names each failure, reads only the login flag, and treats gh as optional', async () => {
  const claude = { command: ['/opt/claude'], args: [], allowedTools: [], disallowedTools: [] }
  type CheckInput = Parameters<typeof runCodingSelfCheck>[0]
  const check = (answers: Record<string, Answer>, extra: Partial<CheckInput> = {}) => runCodingSelfCheck({
    agent: 'claude', config: claude, cwd: '/w', env: {}, platform: 'linux', run: runner(answers), ...extra,
  })
  const loggedIn = { stdout: '{"loggedIn":true,"email":"person@example.com"}' }
  assert.deepEqual(await check({ 'git --version': {}, 'gh auth': { missing: true }, 'claude --version': { stdout: '2.1.280 (Claude Code)\n' }, 'claude auth': loggedIn }), {
    ok: true, agentVersion: '2.1.280 (Claude Code)',
  })
  assert.deepEqual(await check({ 'git --version': { code: null, missing: true } }), { ok: false, reason: 'git_missing' })
  assert.deepEqual(await check({ 'gh auth': { missing: true }, 'claude --version': { code: null, missing: true } }), {
    ok: false, reason: 'agent_missing',
  })
  assert.deepEqual(await check({ 'gh auth': { missing: true }, 'claude auth': { code: 1, stdout: '{"loggedIn":false}' } }), {
    ok: false, reason: 'agent_not_logged_in',
  })
  assert.deepEqual(await check({ 'gh auth': { code: 1 }, 'claude auth': loggedIn }), { ok: false, reason: 'gh_not_authenticated' })
  assert.deepEqual(await check({}, { platform: 'win32', received: { NESSIE_EXECUTOR_SUPERVISOR: 'service' } }), {
    ok: false, reason: 'unsupported_supervisor',
  })
  const codex = await runCodingSelfCheck({
    agent: 'codex', config: { command: ['node', 'codex.js'], args: [], allowedTools: [], disallowedTools: [] }, cwd: '/w', env: {},
    platform: 'linux', run: runner({ 'gh auth': { missing: true }, 'node codex.js login status': { code: 1 } }),
  })
  assert.deepEqual(codex, { ok: false, reason: 'agent_not_logged_in' })
})
