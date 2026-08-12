import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import {
  ExecutorFileListArgumentsSchema,
  ExecutorFileReadArgumentsSchema,
} from '@nessie/schemas'

const DEFAULT_READ_BYTES = 4_096
const DEFAULT_LIST_ENTRIES = 100

class WorkspacePathError extends Error {
  override readonly name = 'WorkspacePathError'
}

const isInside = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

const safeRelativePath = (value: string | undefined): string => {
  const path = value?.trim() || '.'
  if (path.includes('\0') || isAbsolute(path)) {
    throw new WorkspacePathError('Workspace paths must be relative.')
  }
  return path
}

/** The pairing root is fixed and must remain a real, ordinary directory. */
export const configureWorkspaceRoot = async (value: string): Promise<string> => {
  if (!isAbsolute(value)) throw new WorkspacePathError('The workspace root must be absolute.')
  const declared = resolve(value)
  const declaredInfo = await lstat(declared)
  if (declaredInfo.isSymbolicLink() || !declaredInfo.isDirectory()) {
    throw new WorkspacePathError('The workspace root must be an ordinary directory.')
  }
  const canonical = await realpath(declared)
  const canonicalInfo = await lstat(canonical)
  if (canonicalInfo.isSymbolicLink() || !canonicalInfo.isDirectory()) {
    throw new WorkspacePathError('The workspace root is no longer an ordinary directory.')
  }
  return canonical
}

const resolveWorkspacePath = async (workspaceRoot: string, requestedPath: string): Promise<string> => {
  const root = await configureWorkspaceRoot(workspaceRoot)
  const unresolved = resolve(root, safeRelativePath(requestedPath))
  if (!isInside(root, unresolved)) throw new WorkspacePathError('Workspace path escapes its root.')
  let current = root
  for (const segment of relative(root, unresolved).split(sep).filter(Boolean)) {
    current = resolve(current, segment)
    if ((await lstat(current)).isSymbolicLink()) {
      throw new WorkspacePathError('Workspace paths may not traverse symbolic links.')
    }
  }
  const canonical = await realpath(unresolved)
  if (!isInside(root, canonical)) throw new WorkspacePathError('Workspace path resolves outside its root.')
  return canonical
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
  const path = await resolveWorkspacePath(workspaceRoot, safeRelativePath(args.path))
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WorkspacePathError('The requested workspace path is not a directory.')
  }
  const requestedEntries = args.maxEntries ?? DEFAULT_LIST_ENTRIES
  const entries = await readdir(path, { withFileTypes: true })
  const visible = entries
    .filter((entry) => !entry.isSymbolicLink())
    .slice(0, requestedEntries)
    .map((entry) => ({
      kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      name: entry.name.slice(0, 120),
    }))
  return {
    entries: visible,
    path: safeRelativePath(args.path),
    success: true,
    truncated: entries.filter((entry) => !entry.isSymbolicLink()).length > visible.length,
  }
}

export const readWorkspaceFile = async (
  workspaceRoot: string,
  input: unknown,
): Promise<Record<string, unknown>> => {
  const args = ExecutorFileReadArgumentsSchema.parse(input)
  const path = await resolveWorkspacePath(workspaceRoot, safeRelativePath(args.path))
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new WorkspacePathError('The requested workspace path is not a regular file.')
  }
  const maxBytes = args.maxBytes ?? DEFAULT_READ_BYTES
  const result = await readAtMost(path, maxBytes)
  return {
    byteCount: result.data.byteLength,
    content: result.data.toString('utf8'),
    path: safeRelativePath(args.path),
    success: true,
    truncated: result.bytes > maxBytes,
  }
}

export const workspaceFailure = (error: unknown): Record<string, unknown> => ({
  code: error instanceof WorkspacePathError ? 'EXECUTOR_WORKSPACE_DENIED' : 'EXECUTOR_WORKSPACE_UNAVAILABLE',
  success: false,
})
