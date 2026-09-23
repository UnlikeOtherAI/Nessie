import { win32 } from 'node:path'

import { runCommand, type CommandRunner } from './agent-env.js'
import type { CodingAgentConfig } from './config.js'
import type { CodingAgentName } from './types.js'

/**
 * What a host proves before it starts an agent, each failure with its own
 * name because each sends the person to a different fix: install the CLI, log
 * it in, install git, log `gh` in, or run the executor as a person rather than
 * as the Windows service's virtual account (which has no Claude login and no
 * user profile at all).
 *
 * Only exit codes and the `loggedIn` flag are read. `claude auth status` also
 * prints the account's email and organisation, which never leave this function.
 */
export type CodingSelfCheckReason =
  | 'agent_missing'
  | 'agent_not_logged_in'
  | 'git_missing'
  | 'gh_not_authenticated'
  | 'unsupported_supervisor'

export type CodingSelfCheckOutcome =
  | { ok: true; agentVersion?: string }
  | { ok: false; reason: CodingSelfCheckReason }

const VERSION_TEXT = /^[\w .()+-]{1,80}$/u

/**
 * The accounts a Windows service runs as: LocalSystem, LocalService,
 * NetworkService, and every virtual service account (`NT SERVICE\…`, which is
 * what the packaged `NessieExecutor` service uses). None of them is a person,
 * so none has a Claude login, a ChatGPT subscription or a user profile.
 */
const SERVICE_ACCOUNT_SID = /^S-1-5-(?:18|19|20|80(?:-\d+)+)$/u

/**
 * Whether this process runs as a service account, read from the token itself
 * rather than from the supervisor marker, which only a correctly configured
 * service sets. `whoami` is called by its absolute System32 path, so no PATH
 * entry can answer in its place; an answer it cannot read counts as a person,
 * because the login check that follows fails such an account anyway.
 */
export const runsAsWindowsServiceAccount = async (
  run: CommandRunner, received: NodeJS.ProcessEnv = process.env,
): Promise<boolean> => {
  const whoami = win32.join(received.SystemRoot ?? received.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'whoami.exe')
  const answer = await run(whoami, ['/user', '/fo', 'csv', '/nh'], { env: received })
  const sid = /"(S-1-[\d-]+)"\s*$/u.exec(answer.stdout.trim())?.[1]
  return sid !== undefined && SERVICE_ACCOUNT_SID.test(sid)
}

const loggedIn = (agent: CodingAgentName, outcome: { code: number | null; stdout: string }): boolean => {
  if (agent === 'codex') return outcome.code === 0
  try {
    const parsed = JSON.parse(outcome.stdout) as { loggedIn?: unknown }
    if (typeof parsed.loggedIn === 'boolean') return parsed.loggedIn
  } catch {
    // An older CLI prints text; its exit code is the answer.
  }
  return outcome.code === 0
}

export const runCodingSelfCheck = async (input: {
  agent: CodingAgentName
  config: CodingAgentConfig
  cwd: string
  env: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** The host's own environment, where the daemon's supervisor marker arrives. */
  received?: NodeJS.ProcessEnv
  run?: CommandRunner
}): Promise<CodingSelfCheckOutcome> => {
  const run = input.run ?? runCommand
  const platform = input.platform ?? process.platform
  const received = input.received ?? process.env
  if (platform === 'win32' && (
    received.NESSIE_EXECUTOR_SUPERVISOR === 'service' || await runsAsWindowsServiceAccount(run, received)
  )) {
    return { ok: false, reason: 'unsupported_supervisor' }
  }
  const options = { env: input.env, cwd: input.cwd }
  const [git, gh] = await Promise.all([
    run('git', ['--version'], options),
    run('gh', ['auth', 'status'], options),
  ])
  if (git.code !== 0) return { ok: false, reason: 'git_missing' }
  const [program, ...prefix] = input.config.command
  const version = await run(program!, [...prefix, '--version'], options)
  if (version.code !== 0) return { ok: false, reason: 'agent_missing' }
  const login = await run(program!, [...prefix, ...(input.agent === 'claude' ? ['auth', 'status'] : ['login', 'status'])], options)
  if (!loggedIn(input.agent, login)) return { ok: false, reason: 'agent_not_logged_in' }
  // `gh` is optional; a present one that is logged out would make every PR step fail.
  if (!gh.missing && gh.code !== 0) return { ok: false, reason: 'gh_not_authenticated' }
  const firstLine = version.stdout.split(/\r?\n/u)[0]?.trim() ?? ''
  return { ok: true, ...(VERSION_TEXT.test(firstLine) ? { agentVersion: firstLine } : {}) }
}
