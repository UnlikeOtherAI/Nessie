import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import type { CommandRunner } from '../src/coding-session/agent-env.js'
import { agentFailureReason } from '../src/coding-session/agent-process.js'
import { spawnCodingSessionHost } from '../src/coding-session/host-spawn.js'
import {
  CODING_SESSION_UNIT_ENV,
  reachableUserManager,
  stopOwnUserUnit,
  systemdRunArguments,
} from '../src/coding-session/host-unit.js'
import { createCodingProcessControl } from '../src/coding-session/process-control.js'
import { runCodingSelfCheck, runsAsWindowsServiceAccount } from '../src/coding-session/self-check.js'
import { codingSessionPaths } from '../src/coding-session/session-files.js'

/**
 * Containment per supervisor (coding-sessions.md §3): the Windows service
 * refusal, the Linux user unit a host runs in, and the Windows Job Object the
 * native helper holds an agent in. The unit and the service account are
 * decided by what a host can observe, so both are driven through injected
 * observations here and run on any machine; the Job Object needs the built
 * helper and Windows, and runs against the real binary.
 */

const SESSION = '0f0e0d0c-0b0a-4908-8706-050403020100'

const whoami = (sid: string): CommandRunner => async (file, args) => ({
  code: 0,
  missing: false,
  stdout: file.endsWith('whoami.exe') && args.join(' ') === '/user /fo csv /nh' ? `"nt service\\nessieexecutor","${sid}"\r\n` : '',
})

test('a Windows service account is refused before anything runs, whatever its marker says', async () => {
  for (const sid of ['S-1-5-80-2395452366-1486337013-1183271399-3001658651-1409393455', 'S-1-5-18', 'S-1-5-19', 'S-1-5-20']) {
    assert.equal(await runsAsWindowsServiceAccount(whoami(sid), { SystemRoot: 'C:\\Windows' }), true, sid)
    const ran: string[] = []
    const run: CommandRunner = async (file, args, options) => {
      ran.push(file)
      return whoami(sid)(file, args, options)
    }
    assert.deepEqual(await runCodingSelfCheck({
      agent: 'claude', config: { command: ['claude'], args: [], allowedTools: [], disallowedTools: [] },
      cwd: 'C:\\work', env: {}, platform: 'win32', received: { SystemRoot: 'C:\\Windows' }, run,
    }), { ok: false, reason: 'unsupported_supervisor' })
    assert.deepEqual(ran, ['C:\\Windows\\System32\\whoami.exe'], 'nothing but whoami ran, by its absolute path')
  }
  // A person's account, and an answer that cannot be read, are not refused here.
  assert.equal(await runsAsWindowsServiceAccount(whoami('S-1-5-21-3981365695-3656378865-214511470-1001')), false)
  assert.equal(await runsAsWindowsServiceAccount(async () => ({ code: 1, missing: false, stdout: '' })), false)
})

test('a Linux host reaches its user manager through the runtime directory the SDK stripped', () => {
  const both = new Set(['/run/user/1000/systemd/private', '/run/user/1000/bus'])
  assert.deepEqual(reachableUserManager({
    platform: 'linux', uid: 1000, environment: { PATH: '/usr/bin' }, exists: (path) => both.has(path),
  }), {
    environment: { PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
  })
  // A container, or WSL without systemd: no manager, so the host falls back to setsid.
  assert.equal(reachableUserManager({ platform: 'linux', uid: 1000, environment: {}, exists: () => false }), undefined)
  assert.equal(reachableUserManager({ platform: 'darwin', uid: 501, environment: {}, exists: () => true }), undefined)
  assert.equal(reachableUserManager({ platform: 'win32', environment: {}, exists: () => true }), undefined)
})

test('the transient unit carries the host\'s environment, its log, and the kill mode the plan names', () => {
  const args = systemdRunArguments({
    argv: ['/usr/bin/node', '/opt/nessie/nessie-executor.cjs', 'coding-session-host', '--config', '/s/c.json', '--session', SESSION],
    cwd: '/opt/nessie',
    environment: { NESSIE_EXECUTOR_PACKAGED_CLI: '1', NESSIE_CODING_SESSIONS_CONFIG_DIGEST: 'sha256:abc', [CODING_SESSION_UNIT_ENV]: 'forged' },
    hostLog: '/s/coding-sessions/sessions/x/host.log',
    unit: `nessie-coding-${SESSION}`,
  })
  assert.deepEqual(args.slice(0, 5), ['--user', '--collect', '--quiet', '--unit', `nessie-coding-${SESSION}`])
  for (const property of ['KillMode=control-group', 'TimeoutStopSec=10', 'WorkingDirectory=/opt/nessie',
    'StandardOutput=append:/s/coding-sessions/sessions/x/host.log']) {
    assert.equal(args[args.indexOf(property) - 1], '-p', property)
  }
  assert.ok(args.includes('--setenv=NESSIE_EXECUTOR_PACKAGED_CLI=1'))
  assert.ok(args.includes('--setenv=NESSIE_CODING_SESSIONS_CONFIG_DIGEST=sha256:abc'))
  assert.deepEqual(args.filter((arg) => arg.startsWith(`--setenv=${CODING_SESSION_UNIT_ENV}=`)), [
    `--setenv=${CODING_SESSION_UNIT_ENV}=nessie-coding-${SESSION}`,
  ], 'the unit name is the executor\'s, never one the environment brought')
  assert.deepEqual(args.slice(args.indexOf('--') + 1, args.indexOf('--') + 3), ['/usr/bin/node', '/opt/nessie/nessie-executor.cjs'])
})

test('a host starts in its unit when systemd-run takes it, and detached when it refuses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-coding-unit-'))
  try {
    const paths = codingSessionPaths(dir, SESSION)
    await mkdir(paths.dir, { recursive: true })
    const entry = join(dir, 'host-entry.mjs')
    await writeFile(entry, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(join(dir, 'ran'))}, 'yes')\n`)
    const calls: { file: string; args: string[] }[] = []
    const manager = { environment: { XDG_RUNTIME_DIR: '/run/user/1000' } }
    const input = { configPath: join(dir, 'c.json'), entry, paths, sessionId: SESSION }
    assert.equal(await spawnCodingSessionHost(input, {
      userManager: () => manager, runUnit: async (file, args) => { calls.push({ file, args }); return true },
    }), 'unit')
    assert.equal(calls[0]?.file, 'systemd-run')
    assert.ok(calls[0]!.args.includes(`nessie-coding-${SESSION}`))
    assert.ok(existsSync(paths.hostLog), 'the log exists owner-only before systemd opens it')
    assert.equal(existsSync(join(dir, 'ran')), false, 'a started unit is not also spawned')

    assert.equal(await spawnCodingSessionHost(input, { userManager: () => manager, runUnit: async () => false }), 'detached')
    const deadline = Date.now() + 20_000
    while (!existsSync(join(dir, 'ran')) && Date.now() < deadline) await new Promise((settle) => { setTimeout(settle, 100) })
    assert.equal(await readFile(join(dir, 'ran'), 'utf8'), 'yes', 'the refused unit fell back to a detached host')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

test('a closing host stops only its own unit, and only when it has one', async () => {
  const calls: string[][] = []
  const run = async (_file: string, args: string[]) => { calls.push(args); return true }
  assert.equal(await stopOwnUserUnit({}, run), false)
  assert.equal(await stopOwnUserUnit({ [CODING_SESSION_UNIT_ENV]: 'sshd' }, run), false)
  assert.deepEqual(calls, [])
  if (process.platform === 'linux') {
    const stopped = await stopOwnUserUnit({ [CODING_SESSION_UNIT_ENV]: `nessie-coding-${SESSION}` }, run)
    if (stopped) assert.deepEqual(calls[0], ['--user', 'stop', '--no-block', `nessie-coding-${SESSION}.service`])
  }
})

test('the job helper\'s own refusals read as categorical failure reasons', () => {
  assert.equal(agentFailureReason(['{"code":"EXECUTOR_JOB_SPAWN_FAILED","status":"rejected"}']), 'agent_missing')
  assert.equal(agentFailureReason(['{"code":"EXECUTOR_JOB_CONTAINMENT_FAILED","status":"rejected"}']), 'containment_failed')
  assert.equal(agentFailureReason(['{"code":"EXECUTOR_JOB_PARENT_GONE","status":"rejected"}']), 'containment_failed')
})

const NATIVE = fileURLToPath(new URL('../native/target/', import.meta.url))
const builtHelper = ['release', 'debug']
  .map((profile) => join(NATIVE, profile, 'nessie-executor-native.exe'))
  .find((path) => existsSync(path))

/** An agent that starts a child, which starts a grandchild and exits: an orphan `taskkill /T` cannot find. */
const ORPHANING_AGENT = `
const { spawn } = require('node:child_process')
const middle = spawn(process.execPath, ['-e', \`
  const { spawn } = require('node:child_process')
  const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { detached: true, stdio: 'ignore', windowsHide: true })
  console.log(orphan.pid)
\`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
middle.stdout.on('data', (chunk) => process.stdout.write(chunk))
middle.on('exit', () => setTimeout(() => {}, 600000))
`

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('Windows: killing the agent through its Job Object takes the orphaned grandchild too', {
  skip: process.platform !== 'win32' ? 'Windows only' : !builtHelper ? 'build executor/native first' : false,
  timeout: 60_000,
}, async () => {
  const control = createCodingProcessControl('win32', { jobHelper: builtHelper! })
  const agent = control.spawnAgent(process.execPath, ['-e', ORPHANING_AGENT], { cwd: tmpdir(), env: process.env })
  const orphan = await new Promise<number>((settle) => {
    createInterface({ input: agent.stdout! }).once('line', (line) => settle(Number(line.trim())))
  })
  try {
    assert.equal(alive(orphan), true)
    const identity = await control.identify(agent.pid!)
    assert.ok(identity?.startedAt, 'the helper is identified by its start time as well as its pid')
    await control.killTree(identity!, await control.descendants(agent.pid!))
    const deadline = Date.now() + 10_000
    while (alive(orphan) && Date.now() < deadline) await new Promise((settle) => { setTimeout(settle, 100) })
    assert.equal(alive(orphan), false, 'the orphan died with the job')
  } finally {
    if (alive(orphan)) process.kill(orphan)
  }
})
