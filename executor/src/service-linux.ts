import { spawn } from 'node:child_process'
import { lstat, readdir } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { assertPackagedExecutorRuntime } from './runtime-integrity.js'
import { loadExecutorState } from './state-store.js'

/**
 * The `service` supervisor's controls: a systemd user unit per executor id,
 * plus the lingering that makes a user manager start at boot and survive
 * logout. The desktop supervisor owns its own daemon as a child process; these
 * commands never touch it.
 *
 * Every subprocess is an explicit argv array — no shell — and a non-zero exit
 * names the command and its status rather than being swallowed. systemd writes
 * its own diagnostics to stderr, which is inherited, so the person sees them
 * verbatim; nothing here prints keys, challenges, or workspace paths.
 */

const SERVICE_STATE_DIRECTORY = '.local/state/nessie-executor'
const EXECUTOR_STATE_FILE = 'executor-state.json'
const UNIT_TEMPLATE = 'nessie-executor@'
const MAX_CAPTURED_OUTPUT = 16_384

export type ExecutorServiceCommandResult = { code: number; stdout: string }

export type ExecutorServiceEnvironment = {
  confirm: (question: string) => Promise<boolean>
  home: string
  interactive: boolean
  listStateDirectories: (stateRoot: string) => Promise<string[]>
  loadPairedState: (stateDir: string) => Promise<void>
  platform: NodeJS.Platform
  run: (file: string, args: string[]) => Promise<ExecutorServiceCommandResult>
  username: string
  verifyPackagedRuntime: () => Promise<void>
  write: (line: string) => void
}

const spawnCommand = (file: string, args: string[]): Promise<ExecutorServiceCommandResult> => (
  new Promise((settle, fail) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'inherit'] })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_CAPTURED_OUTPUT) stdout += chunk
    })
    child.once('error', () => fail(new Error(`${file} is not available on this host.`)))
    child.once('close', (code, signal) => settle({ code: code ?? (signal ? 1 : 0), stdout }))
  })
)

/** The same rule the desktop applies to an executor id: it becomes a path segment. */
const validIdentifier = (value: string): boolean => (
  value.length > 0 && value.length <= 128 && /^[A-Za-z0-9-]+$/.test(value)
)

const pairedExecutorDirectories = async (stateRoot: string): Promise<string[]> => {
  let entries: string[]
  try {
    entries = await readdir(stateRoot)
  } catch {
    return []
  }
  const paired: string[] = []
  for (const name of entries.sort()) {
    if (!validIdentifier(name)) continue
    try {
      const directory = await lstat(join(stateRoot, name))
      if (directory.isSymbolicLink() || !directory.isDirectory()) continue
      const state = await lstat(join(stateRoot, name, EXECUTOR_STATE_FILE))
      if (!state.isSymbolicLink() && state.isFile()) paired.push(name)
    } catch {
      continue
    }
  }
  return paired
}

export const createExecutorServiceEnvironment = (): ExecutorServiceEnvironment => ({
  confirm: async (question: string) => {
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const answer = (await prompt.question(`${question} [y/N] `)).trim().toLowerCase()
      return answer === 'y' || answer === 'yes'
    } finally {
      prompt.close()
    }
  },
  home: homedir(),
  interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
  listStateDirectories: pairedExecutorDirectories,
  loadPairedState: async (stateDir: string) => {
    await loadExecutorState(stateDir)
  },
  platform: process.platform,
  run: spawnCommand,
  username: userInfo().username,
  verifyPackagedRuntime: assertPackagedExecutorRuntime,
  write: (line: string) => process.stdout.write(`${line}\n`),
})

export const assertExecutorIdentifier = (value: string): string => {
  if (!validIdentifier(value)) throw new Error('The executor id is malformed.')
  return value
}

export const executorServiceStateRoot = (home: string): string => resolve(home, SERVICE_STATE_DIRECTORY)

const requireLinux = (environment: ExecutorServiceEnvironment, command: string): void => {
  if (environment.platform !== 'linux') {
    throw new Error(
      `nessie-executor ${command} controls a systemd user service and is available only on Linux `
      + `(this host is ${environment.platform}).`,
    )
  }
}

const runOrThrow = async (
  environment: ExecutorServiceEnvironment,
  file: string,
  args: string[],
): Promise<ExecutorServiceCommandResult> => {
  const result = await environment.run(file, args)
  if (result.code !== 0) {
    throw new Error(`${file} ${args.join(' ')} exited with status ${result.code}.`)
  }
  return result
}

const unitName = (executorId: string): string => `${UNIT_TEMPLATE}${executorId}.service`

/**
 * The unit template resolves its own state directory from the instance name
 * (`%h/.local/state/nessie-executor/%i`), so enabling an id whose state lives
 * somewhere else would start a service that reads a different directory than
 * the one just verified. `--state-dir` therefore only names the same place by
 * another spelling — a symlinked or bind-mounted state root.
 */
const resolveStateDirectory = (
  environment: ExecutorServiceEnvironment,
  executorId: string,
  requested: string | undefined,
): string => {
  const expected = join(executorServiceStateRoot(environment.home), executorId)
  if (requested === undefined) return expected
  const resolved = resolve(requested)
  if (resolved !== expected) {
    throw new Error(
      `The nessie-executor@${executorId} service reads ~/${SERVICE_STATE_DIRECTORY}/${executorId}. `
      + 'Enabling it against a different state directory would start a different executor.',
    )
  }
  return resolved
}

const LINGER_EXPLANATION = [
  'Lingering starts your systemd user manager at boot and keeps it running after you log out.',
  'That is what keeps this executor online when nobody is signed in.',
  'It applies to your whole user account, not only to Nessie, and `loginctl disable-linger` undoes it.',
]

export type EnableExecutorServiceOptions = {
  assumeYes: boolean
  executorId: string
  stateDir?: string
}

export const enableExecutorService = async (
  options: EnableExecutorServiceOptions,
  environment: ExecutorServiceEnvironment = createExecutorServiceEnvironment(),
): Promise<void> => {
  requireLinux(environment, 'enable')
  const executorId = assertExecutorIdentifier(options.executorId)
  const stateDir = resolveStateDirectory(environment, executorId, options.stateDir)
  try {
    await environment.loadPairedState(stateDir)
  } catch (error) {
    // The state loader's own refusals (missing, foreign owner, group-readable,
    // malformed) are the diagnosis; enabling a service for state that cannot be
    // read would produce a unit that fails at every start instead.
    throw new Error(
      `Executor ${executorId} has no usable paired state in ${stateDir}: `
      + `${error instanceof Error ? error.message : String(error)}. `
      + 'Pair this computer first, then confirm its fingerprint in Nessie.',
    )
  }
  await environment.verifyPackagedRuntime()

  for (const line of LINGER_EXPLANATION) environment.write(line)
  if (!options.assumeYes) {
    if (!environment.interactive) {
      throw new Error(
        'Enabling this executor also enables lingering for your account. '
        + 'Re-run with --yes to accept that without a prompt.',
      )
    }
    if (!await environment.confirm(`Enable lingering for ${environment.username} and start ${unitName(executorId)}?`)) {
      throw new Error('Nothing was changed.')
    }
  }

  // A freshly installed unit template is unknown to an already-running user
  // manager until it reloads.
  await runOrThrow(environment, 'systemctl', ['--user', 'daemon-reload'])
  await runOrThrow(environment, 'systemctl', ['--user', 'enable', '--now', unitName(executorId)])
  await runOrThrow(environment, 'loginctl', ['enable-linger'])
  environment.write(`Enabled ${unitName(executorId)} and lingering for ${environment.username}.`)
  environment.write(`Logs: journalctl --user -u ${unitName(executorId)}`)
}

export const disableExecutorService = async (
  options: { executorId: string },
  environment: ExecutorServiceEnvironment = createExecutorServiceEnvironment(),
): Promise<void> => {
  requireLinux(environment, 'disable')
  const executorId = assertExecutorIdentifier(options.executorId)
  await runOrThrow(environment, 'systemctl', ['--user', 'disable', '--now', unitName(executorId)])
  environment.write(`Disabled ${unitName(executorId)}.`)
  environment.write('Lingering is unchanged; run `loginctl disable-linger` to stop your user manager at boot.')
}

const unitProperty = async (
  environment: ExecutorServiceEnvironment,
  verb: 'is-active' | 'is-enabled',
  executorId: string,
): Promise<string> => {
  // `is-active` and `is-enabled` answer with a status code as well as a word;
  // "inactive" and "disabled" are exit 3, which is an answer, not a failure.
  const result = await environment.run('systemctl', ['--user', verb, unitName(executorId)])
  return result.stdout.trim().split('\n')[0]?.trim() || 'unknown'
}

const lingerState = async (environment: ExecutorServiceEnvironment): Promise<string> => {
  const result = await environment.run('loginctl', ['show-user', environment.username, '-p', 'Linger'])
  if (result.code !== 0) return 'unknown'
  const value = result.stdout.trim().split('=')[1]?.trim()
  return value || 'unknown'
}

export type ExecutorServiceStatusOptions = { executorId?: string; stateRoot?: string }

export const executorServiceStatus = async (
  options: ExecutorServiceStatusOptions,
  environment: ExecutorServiceEnvironment = createExecutorServiceEnvironment(),
): Promise<void> => {
  requireLinux(environment, 'status')
  const stateRoot = options.stateRoot === undefined
    ? executorServiceStateRoot(environment.home)
    : resolve(options.stateRoot)
  const paired = await environment.listStateDirectories(stateRoot)
  const executorIds = options.executorId === undefined
    ? paired
    : [assertExecutorIdentifier(options.executorId)]
  if (options.executorId !== undefined && !paired.includes(options.executorId)) {
    throw new Error(`Executor ${options.executorId} has no paired state under ${stateRoot}.`)
  }
  environment.write(`state root: ${stateRoot}`)
  environment.write(`linger: ${await lingerState(environment)}`)
  if (executorIds.length === 0) {
    environment.write('no paired executors')
    return
  }
  for (const executorId of executorIds) {
    const active = await unitProperty(environment, 'is-active', executorId)
    const enabled = await unitProperty(environment, 'is-enabled', executorId)
    environment.write(`executor ${executorId}: active=${active} enabled=${enabled}`)
  }
}
