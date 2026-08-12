import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export class WorkspacePathError extends Error {
  override readonly name = 'WorkspacePathError'
}

export const isInsideDirectory = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export const safeRelativeWorkspacePath = (value: string | undefined): string => {
  const path = value?.trim() || '.'
  if (path.includes('\0') || isAbsolute(path)) {
    throw new WorkspacePathError('Workspace paths must be relative.')
  }
  return path
}

/** Validate a canonical ordinary directory without following a declared link. */
export const configureOrdinaryDirectory = async (value: string, label: string): Promise<string> => {
  if (!isAbsolute(value)) throw new WorkspacePathError(`${label} must be absolute.`)
  const declared = resolve(value)
  const declaredInfo = await lstat(declared)
  if (declaredInfo.isSymbolicLink() || !declaredInfo.isDirectory()) {
    throw new WorkspacePathError(`${label} must be an ordinary directory.`)
  }
  const canonical = await realpath(declared)
  const canonicalInfo = await lstat(canonical)
  if (canonicalInfo.isSymbolicLink() || !canonicalInfo.isDirectory()) {
    throw new WorkspacePathError(`${label} is no longer an ordinary directory.`)
  }
  return canonical
}

/**
 * Resolve an existing path beneath a root while rejecting every symbolic-link
 * component. The caller receives a canonical path only after the final target
 * exists, is real, and remains beneath the root.
 */
export const resolveExistingWorkspacePath = async (
  workspaceRoot: string,
  requestedPath: string,
): Promise<string> => {
  const root = await configureOrdinaryDirectory(workspaceRoot, 'The workspace root')
  const unresolved = resolve(root, safeRelativeWorkspacePath(requestedPath))
  if (!isInsideDirectory(root, unresolved)) {
    throw new WorkspacePathError('Workspace path escapes its root.')
  }
  let current = root
  for (const segment of relative(root, unresolved).split(sep).filter(Boolean)) {
    current = resolve(current, segment)
    if ((await lstat(current)).isSymbolicLink()) {
      throw new WorkspacePathError('Workspace paths may not traverse symbolic links.')
    }
  }
  const canonical = await realpath(unresolved)
  if (!isInsideDirectory(root, canonical)) {
    throw new WorkspacePathError('Workspace path resolves outside its root.')
  }
  return canonical
}

/** Validate all existing parent components for a path that may be created. */
export const resolveWorkspaceWritePath = async (
  workspaceRoot: string,
  requestedPath: string,
): Promise<{ path: string; relativePath: string; root: string }> => {
  const root = await configureOrdinaryDirectory(workspaceRoot, 'The workspace root')
  const relativePath = safeRelativeWorkspacePath(requestedPath)
  if (relativePath === '.') throw new WorkspacePathError('A workspace file path is required.')
  const destination = resolve(root, relativePath)
  if (!isInsideDirectory(root, destination)) {
    throw new WorkspacePathError('Workspace path escapes its root.')
  }
  const segments = relative(root, destination).split(sep).filter(Boolean)
  let current = root
  for (const segment of segments.slice(0, -1)) {
    current = resolve(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new WorkspacePathError('Workspace paths may not traverse symbolic links.')
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        break
      }
      throw error
    }
  }
  return { path: destination, relativePath, root }
}
