import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'

import { ensureExecutorRuntimeDirectory } from './state-store.js'
import {
  assertGuestWorkspaceLeaseCurrent,
  releaseGuestWorkspaceLease,
  type GuestWorkspaceLease,
} from './guest-workspace-lease.js'
import { WorkspacePathError } from './workspace-paths.js'

const BUILD_TIMEOUT_MS = 90_000
const HANDSHAKE_TIMEOUT_MS = 45_000

type ProcessRunner = (input: { argv: string[]; input: string; path: string; timeoutMs: number }) => Promise<void>

const ownerId = (): number | undefined => process.getuid?.()

const verifyPrivateFile = async (value: string, executable: boolean): Promise<string> => {
  if (!isAbsolute(value)) throw new WorkspacePathError('The executor VM artifact path must be absolute.')
  const declared = resolve(value)
  const initial = await lstat(declared)
  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw new WorkspacePathError('The executor VM artifact must be an ordinary file.')
  }
  const canonical = await realpath(declared)
  const info = await lstat(canonical)
  if (
    info.isSymbolicLink()
    || !info.isFile()
    || (ownerId() !== undefined && info.uid !== ownerId())
    || (info.mode & 0o077) !== 0
    || (executable && (info.mode & constants.S_IXUSR) === 0)
  ) {
    throw new WorkspacePathError('The executor VM artifact must be owner-private and immutable.')
  }
  return canonical
}

const defaultProcessRunner: ProcessRunner = async ({ argv, input, path, timeoutMs }) => {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(path, argv, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new WorkspacePathError('The executor VM helper timed out.'))
    }, timeoutMs)
    child.once('error', () => {
      clearTimeout(timeout)
      reject(new WorkspacePathError('The executor VM helper is unavailable.'))
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolvePromise()
      else reject(new WorkspacePathError('The executor VM helper rejected the guest.'))
    })
    child.stdin?.end(input)
  })
}

const secureSessionDirectory = async (stateDir: string, lease: GuestWorkspaceLease): Promise<string> => {
  const runtime = await ensureExecutorRuntimeDirectory(stateDir)
  const parent = join(runtime, 'guest-vms')
  await mkdir(parent, { mode: 0o700, recursive: true })
  const info = await lstat(parent)
  if (
    info.isSymbolicLink()
    || !info.isDirectory()
    || (ownerId() !== undefined && info.uid !== ownerId())
    || (info.mode & 0o077) !== 0
  ) {
    throw new WorkspacePathError('The executor VM runtime directory is unavailable.')
  }
  const directory = await mkdtemp(join(parent, `${basename(lease.leaseId)}-`))
  await chmod(directory, 0o700)
  return directory
}

export type GuestVmHandshakeInput = {
  guestInitrdBuilderPath: string
  kernelPath: string
  lease: GuestWorkspaceLease
  stateDir: string
  vmHelperPath: string
}

/**
 * Runs one token-bound guest/COW handshake. This is a companion-internal
 * release probe, not an executor operation: it creates no server session and
 * cannot receive a path other than a current daemon-owned COW lease.
 */
export const runGuestVmHandshake = async (
  input: GuestVmHandshakeInput,
  dependencies: { runProcess?: ProcessRunner } = {},
): Promise<{ success: true }> => {
  await assertGuestWorkspaceLeaseCurrent(input.stateDir, input.lease)
  const [builderPath, kernelPath, helperPath] = await Promise.all([
    verifyPrivateFile(input.guestInitrdBuilderPath, true),
    verifyPrivateFile(input.kernelPath, false),
    verifyPrivateFile(input.vmHelperPath, true),
  ])
  const sessionDirectory = await secureSessionDirectory(input.stateDir, input.lease)
  const initrdPath = join(sessionDirectory, 'guest-initrd')
  const consolePath = join(sessionDirectory, 'console')
  const bootstrapToken = randomBytes(32).toString('base64url')
  const runProcess = dependencies.runProcess ?? defaultProcessRunner
  try {
    await runProcess({
      argv: ['--output', initrdPath, '--bootstrap-token-stdin'],
      input: bootstrapToken,
      path: builderPath,
      timeoutMs: BUILD_TIMEOUT_MS,
    })
    await assertGuestWorkspaceLeaseCurrent(input.stateDir, input.lease)
    await runProcess({
      argv: [
        'handshake',
        '--console', consolePath,
        '--kernel', kernelPath,
        '--initrd', initrdPath,
        '--workspace-cow', input.lease.workspace,
        '--bootstrap-token-stdin',
      ],
      input: bootstrapToken,
      path: helperPath,
      timeoutMs: HANDSHAKE_TIMEOUT_MS,
    })
    return { success: true }
  } finally {
    await rm(sessionDirectory, { force: true, recursive: true })
    await releaseGuestWorkspaceLease(input.stateDir, input.lease).catch(() => undefined)
  }
}
