import { spawn, type ChildProcess } from 'node:child_process'

import { runsInOwnUserUnit } from './host-unit.js'
import { createCodingProcessControl, packagedJobHelper, type CodingProcessControl } from './process-control.js'
import type { CodingProcessIdentity } from './types.js'

/**
 * `nessie-executor coding-session-agent-guard`: what ends an agent whose host
 * died, where nothing else would.
 *
 * A packaged Windows host has the job helper's Job Object, which ends the job
 * when the host dies, and a Linux host in its own systemd user unit has the
 * unit's cgroup. Everywhere else — macOS, Linux without a user manager (or
 * whose unit was refused), a Windows development run — a host killed with -9
 * or by the OOM killer left its agent finishing the turn it was in, editing
 * the worktree unobserved. There the host starts the agent through this guard.
 *
 * The guard inherits one extra pipe from the host, at fd 3 (Node's IPC
 * channel), and gets the agent's argv, folder and environment on it — never
 * on its command line. It starts the agent as its own child in a process
 * group of its own (detached on POSIX; hidden on Windows), reports the
 * agent's pid and start time back on that pipe, and only then relays stdin,
 * stdout and stderr. When the pipe closes the host is gone, however it went:
 * the guard kills the agent's group and tree — SIGTERM, then SIGKILL three
 * seconds later on POSIX, pid by pid on Windows, each checked by its start
 * time as every kill is — and exits. On Windows that kill is a PowerShell the
 * guard starts as soon as the agent has an identity and holds ready (it
 * exits with the guard), because a cold one took most of the five seconds on
 * a loaded machine.
 *
 * Otherwise it is transparent. The recorded identity is the agent's own, so
 * every kill the host makes reaches the agent as before and never the guard;
 * the guard exits with the agent's code (or signal) once the agent's output
 * is read, and its own refusals go to stderr as `EXECUTOR_GUARD_*` codes with
 * exit code 125, as the job helper's do. The end of the agent's input is sent
 * on the pipe as well as by closing stdin, because a dead host closes both:
 * stdin alone ending means the host is gone, not that the agent should finish
 * its turn.
 */

export const AGENT_GUARD_COMMAND = 'coding-session-agent-guard'
export const AGENT_GUARD_USAGE = `Usage: nessie-executor ${AGENT_GUARD_COMMAND} (started by a coding-session host, which holds its pipe at fd 3)`

/** The job helper's refusal exit code: the guard ran nothing, or stopped what it could not identify. */
const REFUSED = 125
/** Between SIGTERM and SIGKILL once the host is gone. */
const HOST_GONE_GRACE_MS = 3_000
/** A host sends the agent as soon as the guard starts; a guard told nothing for this long gives up. */
const START_TIMEOUT_MS = 30_000
/** A descendant can hold an exited agent's pipes; a second after its `exit` is enough. */
const DRAIN_MS = 1_000

type AgentStart = { command: string; args: string[]; cwd: string; env: Record<string, string> }

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')

const agentStart = (message: unknown): AgentStart | undefined => {
  const value = message as Partial<AgentStart> | null
  const env = value?.env as unknown
  if (typeof value?.command !== 'string' || !strings(value.args) || typeof value.cwd !== 'string') return undefined
  if (!env || typeof env !== 'object' || !Object.values(env).every((item) => typeof item === 'string')) return undefined
  return { command: value.command, args: value.args, cwd: value.cwd, env: env as Record<string, string> }
}

export type AgentGuardLaunch = { argv: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }

/** The host's side: `spawnAgent` starts the guard, and the identity recorded is the one the guard reports. */
export const guardedProcessControl = (
  control: CodingProcessControl, launch: AgentGuardLaunch,
): CodingProcessControl => ({
  ...control,
  spawnAgent: (command, args, options) => {
    // Detached: on Windows libuv puts every other child in its parent's kill-on-close job, which
    // would end the guard with the host before it could act; on POSIX a kill of the host's group
    // would reach it too.
    const guard = spawn(launch.argv[0]!, launch.argv.slice(1), {
      cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true, shell: false, detached: true,
    })
    // A guard that dies before reading this exits on its own, and that exit is the failure the host sees.
    guard.send({ kind: 'start', command, args, cwd: options.cwd, env: options.env }, () => undefined)
    return guard
  },
  identifySpawned: (guard) => new Promise((settle) => {
    const finish = (identity?: CodingProcessIdentity): void => {
      guard.off('message', onMessage)
      guard.off('exit', onExit)
      settle(identity)
    }
    const onMessage = (message: unknown): void => {
      const report = message as { kind?: unknown; pid?: unknown; startedAt?: unknown } | null
      if (report?.kind !== 'agent' || !Number.isSafeInteger(report.pid) || (report.pid as number) <= 0) return
      if (typeof report.startedAt === 'string' && /^\d+$/u.test(report.startedAt)) {
        finish({ pid: report.pid as number, startedAt: report.startedAt })
      }
    }
    // A guard that exits without a report stopped whatever it started; the reason is on its stderr.
    const onExit = (): void => finish()
    guard.on('message', onMessage)
    guard.once('exit', onExit)
    if (guard.exitCode !== null || guard.signalCode !== null) finish()
  }),
  endInput: (guard) => {
    if (guard.connected) guard.send({ kind: 'endInput' }, () => undefined)
    guard.stdin?.end()
  },
})

/**
 * The control a session host uses. Where a Job Object or its own unit ends a
 * dead host's agent, the platform's own; everywhere else the same control
 * with the agent started through the guard, which runs this executor entry
 * with the host's own runtime arguments and environment.
 */
export const createHostProcessControl = (entry: string, input: {
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  jobHelper?: string
  inOwnUnit?: boolean
} = {}): CodingProcessControl => {
  const platform = input.platform ?? process.platform
  const environment = input.environment ?? process.env
  const jobHelper = 'jobHelper' in input ? input.jobHelper : platform === 'win32' ? packagedJobHelper(environment) : undefined
  const control = createCodingProcessControl(platform, {
    jobHelper, packaged: environment.NESSIE_EXECUTOR_PACKAGED_CLI === '1',
  })
  const contained = jobHelper !== undefined
    || platform === 'linux' && (input.inOwnUnit ?? runsInOwnUserUnit(environment))
  if (control.refusal || contained) return control
  return guardedProcessControl(control, {
    argv: [process.execPath, ...process.execArgv, entry, AGENT_GUARD_COMMAND],
    // The host's own folder, where its runtime arguments (a development loader) resolve.
    cwd: process.cwd(),
    env: environment,
  })
}

const refusal = (code: string): string => `${JSON.stringify({ code, status: 'rejected' })}\n`

/** Resolves once what was written to stdout and stderr has been handed on, or a moment later. */
const flushed = (): Promise<void> => new Promise((settle) => {
  let pending = 2
  const one = (): void => {
    pending -= 1
    if (pending === 0) settle()
  }
  process.stdout.write('', one)
  process.stderr.write('', one)
  setTimeout(settle, DRAIN_MS).unref()
})

/** The guard itself, in the process the host started. */
export const runCodingAgentGuard = async (): Promise<void> => {
  const send = process.send?.bind(process)
  if (!send) throw new Error(AGENT_GUARD_USAGE)
  const control = createCodingProcessControl(process.platform, { termGraceMs: HOST_GONE_GRACE_MS })
  let agent: ChildProcess | undefined
  /** Kills the identified agent's tree; unset until the agent has a start time. */
  let kill: (() => Promise<void>) | undefined
  let hostGone = false
  for (const stream of [process.stdin, process.stdout, process.stderr]) stream.on('error', () => undefined)

  // From here on only this teardown ends the guard: the agent dying of its SIGTERM must not end it before the SIGKILL.
  process.once('disconnect', () => {
    hostGone = true
    void (async () => {
      if (kill) await kill().catch(() => undefined)
      else agent?.kill('SIGKILL')
      process.exit(1)
    })()
  })

  // One listener for the whole life: two messages read together are emitted before any await resumes.
  let hostEndedInput = false
  let stdinEnded = false
  const endAgentInput = (): void => {
    if (hostEndedInput && stdinEnded) agent?.stdin?.end()
  }
  let started: (start: AgentStart | undefined) => void = () => undefined
  const start = new Promise<AgentStart | undefined>((settle) => { started = settle })
  const timer = setTimeout(() => started(undefined), START_TIMEOUT_MS)
  process.on('message', (message: unknown) => {
    const kind = (message as { kind?: unknown } | null)?.kind
    if (kind === 'start') started(agentStart(message))
    if (kind === 'endInput') {
      hostEndedInput = true
      endAgentInput()
    }
  })
  const request = await start
  clearTimeout(timer)
  if (!request) {
    process.stderr.write(refusal('EXECUTOR_GUARD_NO_AGENT'))
    await flushed()
    process.exit(REFUSED)
  }

  const child = control.spawnAgent(request.command, request.args, { cwd: request.cwd, env: request.env })
  agent = child
  let agentExited = false
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle) => {
    child.once('exit', (code, signal) => {
      agentExited = true
      setTimeout(() => settle({ code, signal }), DRAIN_MS).unref()
    })
    child.once('close', (code, signal) => settle({ code, signal }))
  })
  const spawned = await new Promise<boolean>((settle) => {
    child.once('spawn', () => settle(true))
    child.once('error', () => settle(false))
  })
  child.on('error', () => undefined)
  if (!spawned || child.pid === undefined) {
    process.stderr.write(refusal('EXECUTOR_GUARD_SPAWN_FAILED'))
    await flushed()
    process.exit(REFUSED)
  }

  const found = await control.identify(child.pid)
  // An agent with no start time could never be told from whatever inherits its pid, so it does not keep running.
  const unidentified = !found && !agentExited
  if (found) {
    // Made ready before the host can die: a dead host's agent has five seconds, and a cold kill can take most of them.
    kill = control.standbyKill?.(found) ?? (() => control.killTree(found))
    send({ kind: 'agent', pid: found.pid, startedAt: found.startedAt }, () => undefined)
  } else if (unidentified) {
    child.kill('SIGKILL')
  }
  child.stdout?.pipe(process.stdout)
  child.stderr?.pipe(process.stderr)
  if (child.stdin) {
    child.stdin.on('error', () => undefined)
    process.stdin.on('end', () => {
      stdinEnded = true
      endAgentInput()
    })
    process.stdin.pipe(child.stdin, { end: false })
  }

  const { code, signal } = await exited
  if (hostGone) return
  if (unidentified) process.stderr.write(refusal('EXECUTOR_GUARD_CONTAINMENT_FAILED'))
  await flushed()
  if (hostGone) return
  // The agent's own ending, as far as the host can see it: its signal, or its exit code.
  if (signal && !unidentified && process.platform !== 'win32') process.kill(process.pid, signal)
  process.exit(unidentified ? REFUSED : code ?? 1)
}
