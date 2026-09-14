import { randomUUID } from 'node:crypto'
import { open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

import {
  canonicalExecutorJson,
  ExecutorEnrollmentRequestSchema,
  ExecutorIdSchema,
  ExecutorProfileSchema,
  ImplementedExecutorOperationKeySchema,
  type ExecutorEnrollmentRequest,
} from '@nessie/schemas'

import { assertOwnerOnlyStatePath, ensureOwnerOnlyStateDirectory } from './state-security.js'

const STATE_FILE = 'executor-state.json'
const PAIRING_FILE = 'executor-pairing.json'
const RUNTIME_DIRECTORY = 'runtime'
export const DEEPTEST_SOURCE_GRANT_FILE = 'deeptest-source-grant.json'
export const DEEPTEST_EXECUTION_GRANT_FILE = 'deeptest-execution-grant.json'
const STATE_MUTATION_LOCK_FILE = 'executor-state-mutation.lock'

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

/** Credential-free projection that a source-only child may read. */
export type ExecutorDeepTestSourceGrant = Pick<
  ExecutorLocalState,
  'descriptor' | 'executorId' | 'workspaceRoot'
>

/**
 * Credential-free local execution capability. This is deliberately separate
 * from source access: publishing it requires an explicit active-testing opt-in.
 * The browser policy and VM paths are local execution inputs, never targets or
 * browser-profile state.
 */
export type ExecutorDeepTestExecutionGrant = ExecutorDeepTestSourceGrant & {
  browser: { allowedOrigins: string[] }
  runtime: {
    guestInitrdBuilderPath: string
    guestRuntimeBundlePath: string
    kernelPath: string
    vmHelperPath: string
  }
}

/** The VM managers never need paired credentials or control-plane metadata. */
export type ExecutorGuestVmExecutionConfig = Pick<ExecutorLocalState, 'descriptor' | 'workspaceRoot'> & {
  browserSandbox?: ExecutorBrowserSandboxConfig
}

export const executorGuestVmExecutionConfig = (
  grant: ExecutorDeepTestExecutionGrant,
): ExecutorGuestVmExecutionConfig => ({
  browserSandbox: {
    allowedOrigins: [...grant.browser.allowedOrigins],
    guestInitrdBuilderPath: grant.runtime.guestInitrdBuilderPath,
    guestRuntimeBundlePath: grant.runtime.guestRuntimeBundlePath,
    kernelPath: grant.runtime.kernelPath,
    vmHelperPath: grant.runtime.vmHelperPath,
  },
  descriptor: grant.descriptor,
  workspaceRoot: grant.workspaceRoot,
})

/** A literal is required so callers cannot publish by accidentally passing a truthy value. */
export type ExecutorDeepTestExecutionGrantOptIn = { activeTesting: true }

export type ExecutorStateSaveDependencies = {
  replaceJson?: (path: string, value: unknown) => Promise<void>
}

export type ExecutorPreparedPairing = {
  apiBaseUrl: string
  enrollmentId: string
  machinePrivateKey: string
  request: ExecutorEnrollmentRequest
  workspaceRoot: string
}

const statePath = (stateDir: string): string => resolve(stateDir, STATE_FILE)
const pairingPath = (stateDir: string): string => resolve(stateDir, PAIRING_FILE)
export const deepTestSourceGrantPath = (stateDir: string): string =>
  resolve(stateDir, DEEPTEST_SOURCE_GRANT_FILE)
export const deepTestExecutionGrantPath = (stateDir: string): string =>
  resolve(stateDir, DEEPTEST_EXECUTION_GRANT_FILE)

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

const replaceOwnerOnlyJson = async (path: string, value: unknown): Promise<void> => {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.new`
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await assertOwnerOnly(temporaryPath, 'file')
    await rename(temporaryPath, path)
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

const removeOwnerOnlyFile = async (path: string): Promise<void> => {
  try {
    await assertOwnerOnly(path, 'file')
    await unlink(path)
  } catch (error) {
    if (!missing(error)) throw error
  }
}

const withStateMutationLock = async <T>(stateDir: string, mutate: () => Promise<T>): Promise<T> => {
  const lockPath = resolve(stateDir, STATE_MUTATION_LOCK_FILE)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Executor state is already being updated. Try again when that update finishes.')
    }
    throw error
  }
  try {
    await handle.writeFile(`${String(process.pid)}\n`, 'utf8')
    await handle.sync()
    await assertOwnerOnly(lockPath, 'file')
    return await mutate()
  } finally {
    await handle.close().catch(() => undefined)
    await unlink(lockPath).catch(() => undefined)
  }
}

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const present = Object.keys(value)
  return present.length === keys.length && keys.every((key) => key in value)
}

const validPositiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0

const validAbsoluteLocalPath = (value: unknown): value is string =>
  typeof value === 'string' && isAbsolute(value) && !value.includes('\0')

const parseDeepTestSourceGrant = (value: unknown): ExecutorDeepTestSourceGrant => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid grant')
  const grant = value as Record<string, unknown>
  if (!exactKeys(grant, ['descriptor', 'executorId', 'workspaceRoot'])) throw new Error('invalid grant')
  if (!grant.descriptor || typeof grant.descriptor !== 'object' || Array.isArray(grant.descriptor)) {
    throw new Error('invalid grant')
  }
  const descriptor = grant.descriptor as Record<string, unknown>
  if (!exactKeys(descriptor, ['limits', 'operationKeys', 'profiles', 'revision'])) throw new Error('invalid grant')
  if (!descriptor.limits || typeof descriptor.limits !== 'object' || Array.isArray(descriptor.limits)) {
    throw new Error('invalid grant')
  }
  const limits = descriptor.limits as Record<string, unknown>
  if (
    !exactKeys(limits, ['maxCommandRuntimeSeconds', 'maxResultBytes', 'maxSessions'])
    || !validPositiveInteger(limits.maxCommandRuntimeSeconds)
    || !validPositiveInteger(limits.maxResultBytes)
    || !validPositiveInteger(limits.maxSessions)
    || !validPositiveInteger(descriptor.revision)
    || !Array.isArray(descriptor.operationKeys)
    || descriptor.operationKeys.length < 1
    || descriptor.operationKeys.length > 16
    || !descriptor.operationKeys.every((key) => ImplementedExecutorOperationKeySchema.safeParse(key).success)
    || !Array.isArray(descriptor.profiles)
    || descriptor.profiles.length < 1
    || descriptor.profiles.length > 2
    || !descriptor.profiles.every((profile) => ExecutorProfileSchema.safeParse(profile).success)
    || !ExecutorIdSchema.safeParse(grant.executorId).success
    || !validAbsoluteLocalPath(grant.workspaceRoot)
  ) throw new Error('invalid grant')
  return grant as unknown as ExecutorDeepTestSourceGrant
}

const parseDeepTestExecutionGrant = (value: unknown): ExecutorDeepTestExecutionGrant => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid grant')
  const grant = value as Record<string, unknown>
  if (!exactKeys(grant, ['browser', 'descriptor', 'executorId', 'runtime', 'workspaceRoot'])) {
    throw new Error('invalid grant')
  }
  const source = parseDeepTestSourceGrant({
    descriptor: grant.descriptor,
    executorId: grant.executorId,
    workspaceRoot: grant.workspaceRoot,
  })
  if (!grant.browser || typeof grant.browser !== 'object' || Array.isArray(grant.browser)) {
    throw new Error('invalid grant')
  }
  const browser = grant.browser as Record<string, unknown>
  if (
    !exactKeys(browser, ['allowedOrigins'])
    || !Array.isArray(browser.allowedOrigins)
    || browser.allowedOrigins.some((origin) => typeof origin !== 'string' || origin.includes('\0'))
    || !grant.runtime || typeof grant.runtime !== 'object' || Array.isArray(grant.runtime)
  ) throw new Error('invalid grant')
  const runtime = grant.runtime as Record<string, unknown>
  if (
    !exactKeys(runtime, ['guestInitrdBuilderPath', 'guestRuntimeBundlePath', 'kernelPath', 'vmHelperPath'])
    || !validAbsoluteLocalPath(runtime.guestInitrdBuilderPath)
    || !validAbsoluteLocalPath(runtime.guestRuntimeBundlePath)
    || !validAbsoluteLocalPath(runtime.kernelPath)
    || !validAbsoluteLocalPath(runtime.vmHelperPath)
  ) throw new Error('invalid grant')
  return { ...source, browser: { allowedOrigins: [...browser.allowedOrigins] as string[] }, runtime: runtime as ExecutorDeepTestExecutionGrant['runtime'] }
}

const sourceGrantFor = (state: ExecutorLocalState): ExecutorDeepTestSourceGrant => ({
  descriptor: {
    limits: {
      maxCommandRuntimeSeconds: state.descriptor.limits.maxCommandRuntimeSeconds,
      maxResultBytes: state.descriptor.limits.maxResultBytes,
      maxSessions: state.descriptor.limits.maxSessions,
    },
    operationKeys: [...state.descriptor.operationKeys],
    profiles: [...state.descriptor.profiles],
    revision: state.descriptor.revision,
  },
  executorId: state.executorId,
  workspaceRoot: state.workspaceRoot,
})

const executionGrantFor = (state: ExecutorLocalState): ExecutorDeepTestExecutionGrant => {
  const browserSandbox = state.browserSandbox
  const hasActiveExecution = state.descriptor.operationKeys.includes('command.run')
    || ['browser.open', 'browser.observe', 'browser.act'].some(
      (operation) => state.descriptor.operationKeys.includes(operation),
    )
  if (!browserSandbox || !hasActiveExecution) {
    throw new Error('An active DeepTest execution grant requires configured local VM execution operations.')
  }
  return {
    ...sourceGrantFor(state),
    browser: { allowedOrigins: [...browserSandbox.allowedOrigins] },
    runtime: {
      guestInitrdBuilderPath: browserSandbox.guestInitrdBuilderPath,
      guestRuntimeBundlePath: browserSandbox.guestRuntimeBundlePath,
      kernelPath: browserSandbox.kernelPath,
      vmHelperPath: browserSandbox.vmHelperPath,
    },
  }
}

const sameSourceGrant = (
  left: ExecutorDeepTestSourceGrant,
  right: ExecutorDeepTestSourceGrant,
): boolean => (
  left.executorId === right.executorId
  && left.workspaceRoot === right.workspaceRoot
  && left.descriptor.revision === right.descriptor.revision
  && left.descriptor.limits.maxCommandRuntimeSeconds
    === right.descriptor.limits.maxCommandRuntimeSeconds
  && left.descriptor.limits.maxResultBytes === right.descriptor.limits.maxResultBytes
  && left.descriptor.limits.maxSessions === right.descriptor.limits.maxSessions
  && left.descriptor.operationKeys.length === right.descriptor.operationKeys.length
  && left.descriptor.operationKeys.every((key, index) => key === right.descriptor.operationKeys[index])
  && left.descriptor.profiles.length === right.descriptor.profiles.length
  && left.descriptor.profiles.every((profile, index) => profile === right.descriptor.profiles[index])
)

const sameExecutionGrant = (
  left: ExecutorDeepTestExecutionGrant,
  right: ExecutorDeepTestExecutionGrant,
): boolean => (
  sameSourceGrant(left, right)
  && left.browser.allowedOrigins.length === right.browser.allowedOrigins.length
  && left.browser.allowedOrigins.every((origin, index) => origin === right.browser.allowedOrigins[index])
  && left.runtime.guestInitrdBuilderPath === right.runtime.guestInitrdBuilderPath
  && left.runtime.guestRuntimeBundlePath === right.runtime.guestRuntimeBundlePath
  && left.runtime.kernelPath === right.runtime.kernelPath
  && left.runtime.vmHelperPath === right.runtime.vmHelperPath
)

export const loadExecutorDeepTestSourceGrant = async (
  sourceGrantFile: string,
): Promise<ExecutorDeepTestSourceGrant> => {
  if (
    !isAbsolute(sourceGrantFile)
    || basename(sourceGrantFile) !== DEEPTEST_SOURCE_GRANT_FILE
    || sourceGrantFile.includes('\0')
  ) throw new Error('The DeepTest source grant must be its absolute published grant file.')
  const path = resolve(sourceGrantFile)
  await assertOwnerOnly(dirname(path), 'directory')
  await assertOwnerOnly(path, 'file')
  try {
    return parseDeepTestSourceGrant(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (missing(error)) throw error
    throw new Error('The DeepTest source grant is malformed.')
  }
}

export const loadExecutorDeepTestExecutionGrant = async (
  executionGrantFile: string,
): Promise<ExecutorDeepTestExecutionGrant> => {
  if (
    !isAbsolute(executionGrantFile)
    || basename(executionGrantFile) !== DEEPTEST_EXECUTION_GRANT_FILE
    || executionGrantFile.includes('\0')
  ) throw new Error('The DeepTest execution grant must be its absolute published grant file.')
  const path = resolve(executionGrantFile)
  await assertOwnerOnly(dirname(path), 'directory')
  await assertOwnerOnly(path, 'file')
  try {
    return parseDeepTestExecutionGrant(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (missing(error)) throw error
    throw new Error('The DeepTest execution grant is malformed.')
  }
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

const STATE_DIRECTORY_NAME = /^[A-Za-z0-9-]{1,128}$/

/**
 * A native host is registered once per Chrome profile, while a desktop can
 * hold several pairings. Scan only a proved owner-only root and admit a child
 * only when its protected state both loads and names that child. Broken or old
 * entries cannot block another pairing's consent flow.
 */
export const loadExecutorStatesFromRoot = async (stateRoot: string): Promise<ExecutorLocalState[]> => {
  await assertOwnerOnlyStatePath(stateRoot, 'directory')
  const entries = await readdir(stateRoot, { withFileTypes: true })
  const states: ExecutorLocalState[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !STATE_DIRECTORY_NAME.test(entry.name)) continue
    const state = await loadExecutorState(resolve(stateRoot, entry.name)).catch(() => null)
    if (state?.executorId === entry.name) states.push(state)
  }
  return states
}

export const saveExecutorState = async (
  stateDir: string,
  state: ExecutorLocalState,
  expectedState?: ExecutorLocalState,
  dependencies: ExecutorStateSaveDependencies = {},
): Promise<void> => {
  await assertSecureDirectory(stateDir)
  await withStateMutationLock(stateDir, async () => {
    const currentState = await loadExecutorState(stateDir).catch((error: unknown) => {
      if (missing(error)) return null
      throw error
    })
    if (expectedState === undefined) {
      if (currentState !== null) throw new Error('Executor state already exists.')
    } else if (
      currentState === null
      || canonicalExecutorJson(currentState) !== canonicalExecutorJson(expectedState)
    ) {
      throw new Error('Executor state changed before this update could be saved.')
    }
    const grantPath = deepTestSourceGrantPath(stateDir)
    const executionGrantPath = deepTestExecutionGrantPath(stateDir)
    const nextGrant = sourceGrantFor(state)
    const currentGrant = await loadExecutorDeepTestSourceGrant(grantPath).catch(() => null)
    const sourceGrantChanged = currentState === null
      || !sameSourceGrant(sourceGrantFor(currentState), nextGrant)
    const validCurrentGrant = currentGrant !== null && sameSourceGrant(currentGrant, nextGrant)
    if (sourceGrantChanged || !validCurrentGrant) await removeOwnerOnlyFile(grantPath)
    const nextExecutionGrant = (() => {
      try { return executionGrantFor(state) } catch { return null }
    })()
    const currentExecutionGrant = await loadExecutorDeepTestExecutionGrant(executionGrantPath).catch(() => null)
    if (
      nextExecutionGrant === null
      || currentExecutionGrant === null
      || !sameExecutionGrant(currentExecutionGrant, nextExecutionGrant)
    ) await removeOwnerOnlyFile(executionGrantPath)
    const replaceJson = dependencies.replaceJson ?? replaceOwnerOnlyJson
    await replaceJson(statePath(stateDir), state)
    if (sourceGrantChanged) await replaceJson(grantPath, nextGrant)
  })
}

/** Explicit migration/recovery doorway for a pre-grant paired state. */
export const publishExecutorDeepTestSourceGrant = async (stateDir: string): Promise<string> => {
  await assertSecureDirectory(stateDir)
  return await withStateMutationLock(stateDir, async () => {
    await removeOwnerOnlyFile(deepTestSourceGrantPath(stateDir))
    const state = await loadExecutorState(stateDir)
    const path = deepTestSourceGrantPath(stateDir)
    await replaceOwnerOnlyJson(path, sourceGrantFor(state))
    return path
  })
}

/**
 * Publish a separate capability only after the owner explicitly opts into
 * active testing. Possessing a source grant cannot call or imply this action.
 */
export const publishExecutorDeepTestExecutionGrant = async (
  stateDir: string,
  optIn: ExecutorDeepTestExecutionGrantOptIn,
): Promise<string> => {
  if (optIn.activeTesting !== true || Object.keys(optIn).length !== 1) {
    throw new Error('Publishing a DeepTest execution grant requires explicit active-testing opt-in.')
  }
  await assertSecureDirectory(stateDir)
  return await withStateMutationLock(stateDir, async () => {
    const state = await loadExecutorState(stateDir)
    const sourceGrant = await loadExecutorDeepTestSourceGrant(deepTestSourceGrantPath(stateDir)).catch(() => null)
    if (sourceGrant === null || !sameSourceGrant(sourceGrant, sourceGrantFor(state))) {
      throw new Error('A current DeepTest source grant is required before active execution can be published.')
    }
    const path = deepTestExecutionGrantPath(stateDir)
    await removeOwnerOnlyFile(path)
    await replaceOwnerOnlyJson(path, executionGrantFor(state))
    return path
  })
}

export const revokeExecutorDeepTestExecutionGrant = async (stateDir: string): Promise<void> => {
  await assertSecureDirectory(stateDir)
  await withStateMutationLock(stateDir, async () => {
    await removeOwnerOnlyFile(deepTestExecutionGrantPath(stateDir))
  })
}

/** Remove the source grant before deleting the authoritative paired state. */
export const clearExecutorState = async (stateDir: string): Promise<void> => {
  await assertSecureDirectory(stateDir)
  await withStateMutationLock(stateDir, async () => {
    await removeOwnerOnlyFile(deepTestExecutionGrantPath(stateDir))
    await removeOwnerOnlyFile(deepTestSourceGrantPath(stateDir))
    await removeOwnerOnlyFile(statePath(stateDir))
  })
}

const validPreparedPairing = (value: unknown): value is ExecutorPreparedPairing => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prepared = value as Partial<ExecutorPreparedPairing>
  return (
    typeof prepared.apiBaseUrl === 'string'
    && typeof prepared.enrollmentId === 'string'
    && typeof prepared.machinePrivateKey === 'string'
    && typeof prepared.workspaceRoot === 'string'
    && ExecutorEnrollmentRequestSchema.safeParse(prepared.request).success
  )
}

/** Load pairing material prepared before the enrollment request leaves this host. */
export const loadExecutorPreparedPairing = async (
  stateDir: string,
): Promise<ExecutorPreparedPairing | null> => {
  const path = pairingPath(stateDir)
  await assertSecureDirectory(stateDir)
  try {
    await assertOwnerOnly(path, 'file')
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!validPreparedPairing(parsed)) throw new Error('Executor pairing state is malformed.')
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Persist the key and exact signed request before the server can reserve it. */
export const saveExecutorPreparedPairing = async (
  stateDir: string,
  prepared: ExecutorPreparedPairing,
): Promise<void> => {
  await assertSecureDirectory(stateDir)
  await replaceOwnerOnlyJson(pairingPath(stateDir), prepared)
}

export const clearExecutorPreparedPairing = async (stateDir: string): Promise<void> => {
  const path = pairingPath(stateDir)
  try {
    await assertOwnerOnly(path, 'file')
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
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
