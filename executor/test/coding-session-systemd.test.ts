import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { reachableUserManager, type UserManager } from '../src/coding-session/host-unit.js'
import { createCodingProcessControl } from '../src/coding-session/process-control.js'
import { alive, createCodingHarness, waitUntil } from './coding-session-harness.js'

/**
 * The systemd restart case (host-coding-sessions.md → "Containment and
 * teardown, per supervisor"). On Linux with a reachable user manager a session
 * host runs in a unit of its own, so restarting the executor's unit — whose
 * `KillMode=control-group` kills everything in its cgroup — must leave a turn
 * running. A stand-in executor unit with that kill mode starts a real bridge
 * and a held turn and is restarted; the suite then drives the same session
 * from outside it: still working, the same agent, the turn finishes, and a
 * follow-up is served by that agent. It needs a user manager that answers, and
 * says why it skipped when there is none (a container, CI, WSL without
 * systemd).
 */

const EXECUTOR_DIR = fileURLToPath(new URL('..', import.meta.url))
const STAND_IN = fileURLToPath(new URL('./fixtures/stand-in-executor.ts', import.meta.url))

type Outcome = { code: number | null; stdout: string }

const run = (file: string, args: string[], env: NodeJS.ProcessEnv): Promise<Outcome> => new Promise((settle) => {
  execFile(file, args, { env, timeout: 30_000 }, (error, stdout) => {
    const code = (error as { code?: unknown } | null)?.code
    settle({ code: !error ? 0 : typeof code === 'number' ? code : null, stdout: String(stdout ?? '') })
  })
})

/**
 * The user manager, or why there is none to test against. `degraded` counts:
 * some unit on the machine failed, and the manager still starts units.
 */
const userManager = async (): Promise<UserManager | string> => {
  if (process.platform !== 'linux') return 'systemd user units exist only on Linux'
  const manager = reachableUserManager()
  if (!manager) return 'no user manager: /run/user/<uid> has neither systemd/private nor bus'
  const state = (await run('systemctl', ['--user', 'is-system-running'], manager.environment)).stdout.trim()
  return state === 'running' || state === 'degraded' ? manager : `systemctl --user is-system-running answered "${state}"`
}

const lastResultText = (body: Record<string, unknown>): string => (body.lastResult as { text?: string } | undefined)?.text ?? ''

test('restarting the executor\'s unit mid-turn leaves the coding session running', { timeout: 240_000 }, async (t) => {
  const manager = await userManager()
  if (typeof manager === 'string') {
    t.skip(manager)
    return
  }
  const harness = await createCodingHarness()
  const unit = `nessie-stand-in-executor-${randomUUID().slice(0, 8)}`
  const out = join(harness.dir, 'stand-in.json')
  const env = { ...manager.environment, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` }
  const mainPid = async (): Promise<number> => Number((await run('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', unit], env)).stdout.trim())
  const isActive = async (name: string): Promise<string> => (await run('systemctl', ['--user', 'is-active', name], env)).stdout.trim()
  try {
    // The executor unit's own kill mode and supervisor marker (executor/packaging/linux/nessie-executor@.service).
    const started = await run('systemd-run', [
      '--user', '--quiet', '--unit', unit,
      '-p', 'KillMode=control-group', '-p', 'TimeoutStopSec=15', '-p', `WorkingDirectory=${EXECUTOR_DIR}`,
      '--setenv=PATH', '--setenv=HOME', '--setenv=NESSIE_EXECUTOR_SUPERVISOR=service',
      '--', process.execPath, '--import', 'tsx', STAND_IN, harness.configPath, out,
    ], env)
    assert.equal(started.code, 0, 'the stand-in executor unit started')
    const { sessionId } = JSON.parse(await waitUntil(() => readFile(out, 'utf8').catch(() => undefined), 90_000,
      'the stand-in executor to start a session')) as { sessionId: string }
    assert.ok(sessionId, 'the stand-in started a session')
    await harness.waitForStatus(sessionId, (body) => body.status === 'working', undefined, 90_000)
    const agentPid = (await harness.agents()).find((entry) => entry.event === 'start')!.pid as number
    const control = createCodingProcessControl('linux', {})
    const agent = await control.identify(agentPid)
    assert.ok(agent?.startedAt)
    const hostUnit = `nessie-coding-${sessionId}.service`
    assert.equal(await isActive(hostUnit), 'active', 'the host runs in a unit of its own, not in the executor\'s')

    const firstLife = await mainPid()
    assert.ok(firstLife > 0)
    assert.equal((await run('systemctl', ['--user', 'restart', unit], env)).code, 0, 'the executor unit restarted')
    await waitUntil(async () => {
      const current = await mainPid()
      return current > 0 && current !== firstLife ? current : undefined
    }, 30_000, 'the executor unit\'s second life')
    assert.equal(alive(firstLife), false, 'the restart ended the executor\'s first life and its bridge')
    assert.equal(await isActive(hostUnit), 'active', 'the host\'s unit lived through the restart')
    assert.deepEqual(await control.identify(agentPid), agent, 'and so did its agent')
    assert.equal((await harness.call('session_status', { sessionId })).body.status, 'working', 'the turn is still running')

    await harness.release('restart')
    const done = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input', undefined, 60_000)
    assert.equal(done.turn, 1)
    assert.match(lastResultText(done), /work across the restart/)
    assert.equal((await harness.call('session_send', { sessionId, message: 'after the restart' })).ok, true)
    const next = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input' && body.turn === 2,
      undefined, 60_000)
    assert.match(lastResultText(next), /after the restart/)
    assert.equal((await harness.agents()).filter((entry) => entry.event === 'start').length, 1, 'one agent served both turns')
  } finally {
    await run('systemctl', ['--user', 'stop', unit], env)
    await run('systemctl', ['--user', 'reset-failed', unit], env)
    await harness.cleanup()
  }
})
