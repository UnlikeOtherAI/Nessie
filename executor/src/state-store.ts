import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { assertOwnerOnlyStatePath, ensureOwnerOnlyStateDirectory } from './state-security.js'

const STATE_FILE = 'executor-state.json'
const RUNTIME_DIRECTORY = 'runtime'

export type ExecutorBrowserSandboxConfig = {
  allowedOrigins: string[]
  guestInitrdBuilderPath: string
  guestRuntimeBundlePath: string
  kernelPath: string
  vmHelperPath: string
}

/**
 * Local-only Codex configuration. `codexAuthProfilePath` is an owner-private
 * source file, never its contents; a session copies it into a transient guest
 * initrd and removes that copy when the VM stops.
 */
export type ExecutorCodexSandboxConfig = {
  codexAuthProfilePath: string
  guestInitrdBuilderPath: string
  guestRuntimeBundlePath: string
  kernelPath: string
  vmHelperPath: string
}

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
  /** Verified owner-only path to the separately packaged native helper. */
  nativeHelperPath?: string
  /** Local-only browser VM configuration; it is never supplied by Nessie. */
  browserSandbox?: ExecutorBrowserSandboxConfig
  /** Local-only Codex VM configuration; it is never supplied by Nessie. */
  codexSandbox?: ExecutorCodexSandboxConfig
  /** Canonical, single read-only host directory selected during pairing. */
  workspaceRoot: string
}

const statePath = (stateDir: string): string => resolve(stateDir, STATE_FILE)

const validBrowserSandbox = (value: unknown): value is ExecutorBrowserSandboxConfig => (
  Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value)
  && Array.isArray((value as ExecutorBrowserSandboxConfig).allowedOrigins)
  && (value as ExecutorBrowserSandboxConfig).allowedOrigins.every((origin) => typeof origin === 'string')
  && typeof (value as ExecutorBrowserSandboxConfig).guestInitrdBuilderPath === 'string'
  && typeof (value as ExecutorBrowserSandboxConfig).guestRuntimeBundlePath === 'string'
  && typeof (value as ExecutorBrowserSandboxConfig).kernelPath === 'string'
  && typeof (value as ExecutorBrowserSandboxConfig).vmHelperPath === 'string'
)

const validCodexSandbox = (value: unknown): value is ExecutorCodexSandboxConfig => (
  Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value)
  && typeof (value as ExecutorCodexSandboxConfig).codexAuthProfilePath === 'string'
  && typeof (value as ExecutorCodexSandboxConfig).guestInitrdBuilderPath === 'string'
  && typeof (value as ExecutorCodexSandboxConfig).guestRuntimeBundlePath === 'string'
  && typeof (value as ExecutorCodexSandboxConfig).kernelPath === 'string'
  && typeof (value as ExecutorCodexSandboxConfig).vmHelperPath === 'string'
)

/**
 * Owner-only proof is host-shaped — POSIX mode bits, a Windows DACL — and lives
 * in one place so the state file and the daemon lease cannot disagree about
 * what private means.
 */
const assertOwnerOnly = async (path: string, expectedKind: 'directory' | 'file'): Promise<void> => {
  await assertOwnerOnlyStatePath(path, expectedKind)
}

const assertSecureDirectory = async (stateDir: string): Promise<void> => {
  await ensureOwnerOnlyStateDirectory(stateDir)
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
    || (parsed.nativeHelperPath !== undefined && typeof parsed.nativeHelperPath !== 'string')
    || (parsed.browserSandbox !== undefined && !validBrowserSandbox(parsed.browserSandbox))
    || (parsed.codexSandbox !== undefined && !validCodexSandbox(parsed.codexSandbox))
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
  return ensureOwnerOnlyStateDirectory(resolve(stateDir, RUNTIME_DIRECTORY))
}
