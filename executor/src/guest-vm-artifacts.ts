import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'

import { ensureExecutorRuntimeDirectory } from './state-store.js'
import type { GuestWorkspaceLease } from './guest-workspace-lease.js'
import { WorkspacePathError } from './workspace-paths.js'

export const GUEST_VM_BUILD_TIMEOUT_MS = 90_000
export const GUEST_VM_HANDSHAKE_TIMEOUT_MS = 45_000

export type GuestVmProcessRunner = (input: {
  argv: string[]
  input: string
  path: string
  timeoutMs: number
}) => Promise<void>

const ownerId = (): number | undefined => process.getuid?.()

export const verifyPrivateGuestVmFile = async (value: string, executable: boolean): Promise<string> => {
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

export const runGuestVmProcess: GuestVmProcessRunner = async ({ argv, input, path, timeoutMs }) => {
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

export const secureGuestVmSessionDirectory = async (
  stateDir: string,
  lease: GuestWorkspaceLease,
): Promise<string> => {
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
