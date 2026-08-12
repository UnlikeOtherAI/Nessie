import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import {
  ExecutorFileListArgumentsSchema,
  ExecutorFileReadArgumentsSchema,
} from '@nessie/schemas'

import {
  WorkspacePathError,
  EXECUTOR_PROMOTION_JOURNAL_DIRECTORY,
  configureOrdinaryDirectory,
  resolveExistingWorkspacePath,
  safeRelativeWorkspacePath,
} from './workspace-paths.js'

const DEFAULT_READ_BYTES = 4_096
const DEFAULT_LIST_ENTRIES = 100

/** The pairing root is fixed and must remain a real, ordinary directory. */
export const configureWorkspaceRoot = async (value: string): Promise<string> => {
  if (!isAbsolute(value)) throw new WorkspacePathError('The workspace root must be absolute.')
  return configureOrdinaryDirectory(value, 'The workspace root')
}

const readAtMost = async (path: string, maxBytes: number): Promise<{ bytes: number; data: Buffer }> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
      if (bytesRead === 0) break
      bytes += bytesRead
    }
    return { bytes, data: buffer.subarray(0, Math.min(bytes, maxBytes)) }
  } finally {
    await handle.close()
  }
}

export const listWorkspaceFiles = async (
  workspaceRoot: string,
  input: unknown,
): Promise<Record<string, unknown>> => {
  const args = ExecutorFileListArgumentsSchema.parse(input)
  const path = await resolveExistingWorkspacePath(workspaceRoot, safeRelativeWorkspacePath(args.path))
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WorkspacePathError('The requested workspace path is not a directory.')
  }
  const requestedEntries = args.maxEntries ?? DEFAULT_LIST_ENTRIES
  const entries = await readdir(path, { withFileTypes: true })
  const visible = entries
    .filter((entry) => !entry.isSymbolicLink())
    .filter((entry) => entry.name !== EXECUTOR_PROMOTION_JOURNAL_DIRECTORY)
    .slice(0, requestedEntries)
    .map((entry) => ({
      kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      name: entry.name.slice(0, 120),
    }))
  return {
    entries: visible,
    path: safeRelativeWorkspacePath(args.path),
    success: true,
    truncated: entries.filter((entry) => (
      !entry.isSymbolicLink() && entry.name !== EXECUTOR_PROMOTION_JOURNAL_DIRECTORY
    )).length > visible.length,
  }
}

export const readWorkspaceFile = async (
  workspaceRoot: string,
  input: unknown,
): Promise<Record<string, unknown>> => {
  const args = ExecutorFileReadArgumentsSchema.parse(input)
  const path = await resolveExistingWorkspacePath(workspaceRoot, safeRelativeWorkspacePath(args.path))
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new WorkspacePathError('The requested workspace path is not a regular file.')
  }
  const maxBytes = args.maxBytes ?? DEFAULT_READ_BYTES
  const result = await readAtMost(path, maxBytes)
  return {
    byteCount: result.data.byteLength,
    content: result.data.toString('utf8'),
    path: safeRelativeWorkspacePath(args.path),
    success: true,
    truncated: result.bytes > maxBytes,
  }
}

export const workspaceFailure = (error: unknown): Record<string, unknown> => ({
  code: error instanceof WorkspacePathError ? 'EXECUTOR_WORKSPACE_DENIED' : 'EXECUTOR_WORKSPACE_UNAVAILABLE',
  success: false,
})
