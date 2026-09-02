import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { RunIdSchema } from '@nessie/schemas'

import { ensureExecutorRuntimeDirectory } from './state-store.js'
import { WorkspacePathError, isInsideDirectory } from './workspace-paths.js'

/**
 * Where a run's sandbox lives, how much it may hold, and the guards every
 * operation on it shares. The snapshot, the draft writes, and the review each
 * build on exactly these facts and never restate them.
 */

// A draft never has more storage than the snapshot it started from. Keeping
// these limits equal avoids copying a source tree that can never accept a
// write, while still leaving ordinary read-only operations unconstrained by
// the COW cap.
export const MAX_SOURCE_BYTES = 128 * 1024 * 1024
export const MAX_SOURCE_FILES = 10_000
export const MAX_SCRATCH_BYTES = MAX_SOURCE_BYTES
export const COPY_BUFFER_BYTES = 64 * 1024

/** Bytes and files counted against one of the limits above. */
export type SandboxUsage = { bytes: number; files: number }

export const missing = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')

export const assertOrdinaryDirectory = async (path: string, message: string): Promise<void> => {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new WorkspacePathError(message)
}

const sandboxDirectory = async (stateDir: string): Promise<string> => {
  const runtimeDir = await ensureExecutorRuntimeDirectory(stateDir)
  const sandboxes = resolve(runtimeDir, 'sandboxes')
  await mkdir(sandboxes, { mode: 0o700, recursive: true })
  await assertOrdinaryDirectory(sandboxes, 'The executor sandbox directory is unavailable.')
  return sandboxes
}

export const sandboxPaths = async (stateDir: string, runId: string) => {
  const parsedRunId = RunIdSchema.parse(runId)
  const parent = await sandboxDirectory(stateDir)
  const root = resolve(parent, parsedRunId)
  if (!isInsideDirectory(parent, root) || basename(root) !== parsedRunId) {
    throw new WorkspacePathError('The sandbox identity is invalid.')
  }
  return {
    baseManifest: resolve(root, 'base-manifest.json'),
    guestLease: resolve(root, 'guest-lease.json'),
    parent,
    root,
    workspace: resolve(root, 'workspace'),
  }
}

/** Creates an owner-only file that must not already exist, then syncs it. */
export const writeAll = async (path: string, content: string): Promise<void> => {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const bytes = Buffer.from(content, 'utf8')
    let written = 0
    while (written < bytes.byteLength) {
      const result = await handle.write(bytes, written, bytes.byteLength - written, written)
      written += result.bytesWritten
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}
