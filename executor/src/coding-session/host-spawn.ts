import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { open, readFile, unlink } from 'node:fs/promises'
import { basename } from 'node:path'

import { reachableUserManager, startHostInUserUnit, type UnitRunner, type UserManager } from './host-unit.js'
import { createJsonExclusive, readJson, rotateLogIfLarge, type CodingSessionPaths } from './session-files.js'
import { hostLockIsStale, readHostLock } from './session-lock.js'
import { writeRequest } from './session-requests.js'
import { CODING_SESSION_PROTOCOL_VERSION } from './types.js'

/**
 * How the bridge makes sure a session has a live host, and starts one.
 *
 * The host is this same executor entry run as `coding-session-host`, with the
 * bridge's exec arguments and environment (so a development loader and the
 * packaged-CLI marker both survive), with its output in the session's bounded
 * `host.log`, in a systemd user unit of its own on Linux and detached
 * everywhere else. It outlives the bridge: the daemon's idle close, the
 * reporter's probe and a daemon restart all kill the bridge, and none of them
 * may take a coding turn with it.
 */

const ENTRY_NAMES = ['index.js', 'index.ts', 'nessie-executor.cjs']
const HOST_LOG_BYTES = 1024 * 1024
/** A host takes a second or three to start on Windows; the bridge does not start a second one meanwhile. */
const SPAWN_GRACE_MS = 15_000

export const resolveExecutorEntry = (invoked: string | undefined = process.argv[1]): string => {
  if (!invoked) throw new Error('The executor entry point is unknown.')
  const entry = realpathSync(invoked)
  if (!ENTRY_NAMES.includes(basename(entry))) {
    throw new Error('The coding-sessions bridge runs only from the executor entry point.')
  }
  return entry
}

const digests = new Map<string, Promise<string>>()

/** The running executor's own code, so a bridge can tell a host from an older install. */
export const executorRuntimeDigest = (entry: string): Promise<string> => {
  let digest = digests.get(entry)
  if (!digest) {
    digest = readFile(entry).then((bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`)
    digests.set(entry, digest)
  }
  return digest
}

export type HostSpawnOptions = {
  userManager?: () => UserManager | undefined
  runUnit?: UnitRunner
}

/**
 * On Linux with a reachable user manager the host gets a systemd user unit of
 * its own (see `host-unit.ts`); everywhere else, and whenever that start is
 * refused, it is a detached process — its own session on POSIX, and on
 * Windows a process whose agent the native helper's Job Object contains.
 */
export const spawnCodingSessionHost = async (input: {
  configPath: string
  entry: string
  paths: CodingSessionPaths
  sessionId: string
}, options: HostSpawnOptions = {}): Promise<'unit' | 'detached'> => {
  await rotateLogIfLarge(input.paths.hostLog, HOST_LOG_BYTES)
  const log = await open(input.paths.hostLog, 'a', 0o600)
  const argv = [
    process.execPath, ...process.execArgv,
    input.entry, 'coding-session-host', '--config', input.configPath, '--session', input.sessionId,
  ]
  const manager = (options.userManager ?? reachableUserManager)()
  if (manager) {
    await log.close()
    const started = await startHostInUserUnit({
      argv, hostLog: input.paths.hostLog, sessionId: input.sessionId, manager,
      ...(options.runUnit ? { run: options.runUnit } : {}),
    })
    if (started) return 'unit'
    return spawnCodingSessionHost(input, { ...options, userManager: () => undefined })
  }
  try {
    const child = spawn(argv[0]!, argv.slice(1), {
      detached: true, env: process.env, stdio: ['ignore', log.fd, log.fd], windowsHide: true,
    })
    await new Promise<void>((settle, fail) => {
      child.once('spawn', () => settle())
      child.once('error', fail)
    })
    child.unref()
  } finally {
    await log.close()
  }
  return 'detached'
}

type SpawnMarker = { at: number }

export type HostAssurance = 'live' | 'starting' | 'spawned'

/**
 * A live host is left alone (and asked to retire after its turn when it runs
 * older code). Otherwise a host is spawned unless one was requested in the
 * last fifteen seconds and has not yet taken the lock — a second write in that
 * window would otherwise start a second host racing the first.
 */
export const ensureCodingSessionHost = async (input: {
  configPath: string
  entry: string
  paths: CodingSessionPaths
  sessionId: string
}): Promise<HostAssurance> => {
  const lock = await readHostLock(input.paths.lock)
  if (lock && !hostLockIsStale(lock)) {
    const digest = await executorRuntimeDigest(input.entry)
    if (lock.protocolVersion < CODING_SESSION_PROTOCOL_VERSION || lock.runtimeDigest !== digest) {
      await writeRequest(input.paths, { id: 'retire', kind: 'retire', at: new Date().toISOString() }).catch(() => false)
    }
    return 'live'
  }
  const marker = await readJson<SpawnMarker>(input.paths.spawnMarker)
  const now = Date.now()
  const requestedRecently = typeof marker?.at === 'number' && now - marker.at < SPAWN_GRACE_MS
  const tookOver = lock !== undefined && typeof marker?.at === 'number' && Date.parse(lock.startedAt) >= marker.at
  if (requestedRecently && !tookOver) return 'starting'
  await unlink(input.paths.spawnMarker).catch(() => undefined)
  if (!await createJsonExclusive(input.paths.spawnMarker, { at: now } satisfies SpawnMarker)) return 'starting'
  await spawnCodingSessionHost(input)
  return 'spawned'
}

/** A host was asked for and has not had the time to take the lock yet. */
export const codingHostSpawnPending = async (paths: CodingSessionPaths): Promise<boolean> => {
  const marker = await readJson<SpawnMarker>(paths.spawnMarker)
  if (typeof marker?.at !== 'number' || Date.now() - marker.at >= SPAWN_GRACE_MS) return false
  const lock = await readHostLock(paths.lock)
  return !lock || Date.parse(lock.startedAt) < marker.at
}
