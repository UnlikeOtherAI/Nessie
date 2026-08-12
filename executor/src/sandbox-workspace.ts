import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'

import { ExecutorFileWriteArgumentsSchema, RunIdSchema } from '@nessie/schemas'

import { ensureExecutorRuntimeDirectory } from './state-store.js'
import {
  WorkspacePathError,
  configureOrdinaryDirectory,
  isInsideDirectory,
  resolveWorkspaceWritePath,
} from './workspace-paths.js'
import { configureWorkspaceRoot } from './workspace.js'

const MAX_SOURCE_BYTES = 512 * 1024 * 1024
const MAX_SOURCE_FILES = 10_000
const COPY_BUFFER_BYTES = 64 * 1024

type CopyBudget = { bytes: number; files: number }

const missing = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')

const assertOrdinaryDirectory = async (path: string, message: string): Promise<void> => {
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

const sandboxPaths = async (stateDir: string, runId: string) => {
  const parsedRunId = RunIdSchema.parse(runId)
  const parent = await sandboxDirectory(stateDir)
  const root = resolve(parent, parsedRunId)
  if (!isInsideDirectory(parent, root) || basename(root) !== parsedRunId) {
    throw new WorkspacePathError('The sandbox identity is invalid.')
  }
  return { parent, root, workspace: resolve(root, 'workspace') }
}

const copyFileWithoutFollowingLinks = async (
  source: string,
  destination: string,
  budget: CopyBudget,
): Promise<void> => {
  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await sourceHandle.stat()
    if (!info.isFile() || info.nlink > 1) {
      throw new WorkspacePathError('Sandbox sources may contain only non-linked regular files.')
    }
    budget.files += 1
    budget.bytes += info.size
    if (budget.files > MAX_SOURCE_FILES || budget.bytes > MAX_SOURCE_BYTES) {
      throw new WorkspacePathError('The paired workspace exceeds the sandbox copy limit.')
    }
    const destinationHandle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
      let position = 0
      while (true) {
        const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break
        let written = 0
        while (written < bytesRead) {
          const write = await destinationHandle.write(buffer, written, bytesRead - written, position + written)
          written += write.bytesWritten
        }
        position += bytesRead
      }
      await destinationHandle.sync()
    } finally {
      await destinationHandle.close()
    }
  } finally {
    await sourceHandle.close()
  }
}

const copyTreeWithoutLinks = async (
  source: string,
  destination: string,
  budget: CopyBudget,
): Promise<void> => {
  const info = await lstat(source)
  if (info.isSymbolicLink()) {
    throw new WorkspacePathError('Sandbox sources may not contain symbolic links.')
  }
  if (info.isDirectory()) {
    await mkdir(destination, { mode: 0o700 })
    const entries = await readdir(source, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      await copyTreeWithoutLinks(resolve(source, entry.name), resolve(destination, entry.name), budget)
    }
    return
  }
  if (info.isFile()) {
    await copyFileWithoutFollowingLinks(source, destination, budget)
    return
  }
  throw new WorkspacePathError('Sandbox sources may not contain special files.')
}

/**
 * Lazily creates a daemon-owned, copy-on-write snapshot for one run. The host
 * pairing root is read only here; no command can write it. A future promote
 * operation must perform its own reviewed host-write protocol.
 */
export const ensureSandboxWorkspace = async (
  stateDir: string,
  workspaceRoot: string,
  runId: string,
): Promise<string> => {
  const source = await configureWorkspaceRoot(workspaceRoot)
  const paths = await sandboxPaths(stateDir, runId)
  try {
    await assertOrdinaryDirectory(paths.root, 'The executor sandbox is unavailable.')
  } catch (error) {
    if (!missing(error)) throw error
    const staging = resolve(paths.parent, `.${RunIdSchema.parse(runId)}.${randomUUID()}.new`)
    if (!isInsideDirectory(paths.parent, staging)) {
      throw new WorkspacePathError('The executor sandbox staging path is invalid.')
    }
    await mkdir(staging, { mode: 0o700 })
    try {
      await copyTreeWithoutLinks(source, resolve(staging, 'workspace'), { bytes: 0, files: 0 })
      await rename(staging, paths.root)
    } catch (copyError) {
      await rm(staging, { force: true, recursive: true })
      throw copyError
    }
    return configureOrdinaryDirectory(paths.workspace, 'The executor sandbox workspace')
  }
  try {
    return await configureOrdinaryDirectory(paths.workspace, 'The executor sandbox workspace')
  } catch (error) {
    throw new WorkspacePathError(
      error instanceof Error ? error.message : 'The executor sandbox workspace is unavailable.',
    )
  }
}

/** Use COW state when it exists; ordinary read-only work keeps the host snapshot. */
export const workspaceForRun = async (
  stateDir: string,
  workspaceRoot: string,
  runId: string,
): Promise<string> => {
  const paths = await sandboxPaths(stateDir, runId)
  try {
    return await configureOrdinaryDirectory(paths.workspace, 'The executor sandbox workspace')
  } catch (error) {
    try {
      await assertOrdinaryDirectory(paths.root, 'The executor sandbox is unavailable.')
    } catch (rootError) {
      if (!missing(rootError)) throw rootError
      return configureWorkspaceRoot(workspaceRoot)
    }
    throw error
  }
}

const ensureWriteParents = async (
  workspace: string,
  destination: string,
  createParents: boolean,
): Promise<void> => {
  const parent = dirname(destination)
  const segments = relative(workspace, parent).split(sep).filter(Boolean)
  let current = workspace
  for (const segment of segments) {
    current = resolve(current, segment)
    try {
      await assertOrdinaryDirectory(current, 'Sandbox paths may not traverse symbolic links.')
    } catch (error) {
      if (!missing(error)) throw error
      if (!createParents) throw new WorkspacePathError('The sandbox parent directory does not exist.')
      await mkdir(current, { mode: 0o700 })
      await assertOrdinaryDirectory(current, 'The sandbox parent directory is unavailable.')
    }
  }
}

const writeAll = async (path: string, content: string): Promise<void> => {
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

export const writeSandboxFile = async (
  stateDir: string,
  workspaceRoot: string,
  runId: string,
  input: unknown,
): Promise<Record<string, unknown>> => {
  const args = ExecutorFileWriteArgumentsSchema.parse(input)
  const workspace = await ensureSandboxWorkspace(stateDir, workspaceRoot, runId)
  const destination = await resolveWorkspaceWritePath(workspace, args.path)
  await ensureWriteParents(workspace, destination.path, args.createParents === true)
  try {
    const existing = await lstat(destination.path)
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new WorkspacePathError('The sandbox destination must be a regular file.')
    }
    if (args.overwrite !== true) {
      throw new WorkspacePathError('The sandbox destination already exists.')
    }
  } catch (error) {
    if (!missing(error)) throw error
  }
  const temporary = resolve(dirname(destination.path), `.${basename(destination.path)}.${randomUUID()}.new`)
  await writeAll(temporary, args.content)
  try {
    if (args.overwrite !== true) {
      try {
        await lstat(destination.path)
        throw new WorkspacePathError('The sandbox destination already exists.')
      } catch (error) {
        if (!missing(error)) throw error
      }
    }
    await rename(temporary, destination.path)
  } finally {
    await rm(temporary, { force: true })
  }
  return {
    byteCount: Buffer.byteLength(args.content, 'utf8'),
    path: destination.relativePath,
    success: true,
  }
}

/** Stop discards only the exact daemon-owned COW workspace for this run. */
export const stopSandboxWorkspace = async (stateDir: string, runId: string): Promise<boolean> => {
  const paths = await sandboxPaths(stateDir, runId)
  try {
    await assertOrdinaryDirectory(paths.root, 'The executor sandbox is unavailable.')
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
  await rm(paths.root, { force: true, recursive: true })
  return true
}
