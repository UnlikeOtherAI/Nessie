import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const STATE_FILE = 'executor-state.json'
const RUNTIME_DIRECTORY = 'runtime'
const MODE_MASK_GROUP_OR_OTHER = 0o077

export type ExecutorLocalState = {
  apiBaseUrl: string
  connectionEpoch?: string
  descriptor: {
    limits: { maxCommandRuntimeSeconds: number; maxResultBytes: number; maxSessions: number }
    operationKeys: string[]
    profiles: string[]
    revision: number
  }
  executorId: string
  machinePrivateKey: string
  machinePublicKey: string
  /** Canonical, single read-only host directory selected during pairing. */
  workspaceRoot: string
}

const statePath = (stateDir: string): string => resolve(stateDir, STATE_FILE)

const ownerId = (): number | undefined => process.getuid?.()

const assertOwnerOnly = async (
  path: string,
  expectedKind: 'directory' | 'file',
): Promise<void> => {
  const current = await lstat(path)
  if (current.isSymbolicLink() || (expectedKind === 'directory' ? !current.isDirectory() : !current.isFile())) {
    throw new Error(`Executor state path ${path} must be an ordinary ${expectedKind}.`)
  }
  if (ownerId() !== undefined && current.uid !== ownerId()) {
    throw new Error(`Executor state path ${path} must be owned by the current user.`)
  }
  if ((current.mode & MODE_MASK_GROUP_OR_OTHER) !== 0) {
    throw new Error(`Executor state path ${path} must not be accessible by other users.`)
  }
}

const assertSecureDirectory = async (stateDir: string): Promise<void> => {
  const resolved = resolve(stateDir)
  await mkdir(resolved, { mode: 0o700, recursive: true })
  await assertOwnerOnly(resolved, 'directory')
}

export const loadExecutorState = async (stateDir: string): Promise<ExecutorLocalState> => {
  const path = statePath(stateDir)
  await assertOwnerOnly(dirname(path), 'directory')
  await assertOwnerOnly(path, 'file')
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ExecutorLocalState>
  if (
    typeof parsed.apiBaseUrl !== 'string'
    || typeof parsed.executorId !== 'string'
    || typeof parsed.machinePrivateKey !== 'string'
    || typeof parsed.machinePublicKey !== 'string'
    || typeof parsed.workspaceRoot !== 'string'
    || !parsed.descriptor
  ) {
    throw new Error('Executor state is malformed.')
  }
  return parsed as ExecutorLocalState
}

export const saveExecutorState = async (
  stateDir: string,
  state: ExecutorLocalState,
): Promise<void> => {
  await assertSecureDirectory(stateDir)
  const path = statePath(stateDir)
  const temporaryPath = `${path}.new`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    await assertOwnerOnly(temporaryPath, 'file')
    await rename(temporaryPath, path)
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

/**
 * Daemon-owned scratch state lives beside the owner-only key file, never below
 * the paired workspace. A caller may safely derive child directories from this
 * returned canonical path without making any user-selected path writable.
 */
export const ensureExecutorRuntimeDirectory = async (stateDir: string): Promise<string> => {
  await assertSecureDirectory(stateDir)
  const runtimeDir = resolve(stateDir, RUNTIME_DIRECTORY)
  await mkdir(runtimeDir, { mode: 0o700, recursive: true })
  await assertOwnerOnly(runtimeDir, 'directory')
  return runtimeDir
}
