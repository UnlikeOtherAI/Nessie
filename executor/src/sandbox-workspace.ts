import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'

import {
  canonicalExecutorJson,
  ExecutorFileWriteArgumentsSchema,
  RunIdSchema,
} from '@nessie/schemas'

import { ensureExecutorRuntimeDirectory } from './state-store.js'
import {
  WorkspacePathError,
  configureOrdinaryDirectory,
  isInsideDirectory,
  resolveWorkspaceWritePath,
} from './workspace-paths.js'
import { configureWorkspaceRoot } from './workspace.js'

// A draft never has more storage than the snapshot it started from. Keeping
// these limits equal avoids copying a source tree that can never accept a
// write, while still leaving ordinary read-only operations unconstrained by
// the COW cap.
const MAX_SOURCE_BYTES = 128 * 1024 * 1024
const MAX_SOURCE_FILES = 10_000
const MAX_SCRATCH_BYTES = MAX_SOURCE_BYTES
const MAX_REVIEW_CHANGES = 100
// Command receipts are capped at 64 KiB server-side. Keep margin for JSON
// escaping of otherwise valid local filenames and never turn a large review
// into an ambiguous terminal receipt.
const MAX_REVIEW_RESULT_BYTES = 60 * 1024
const COPY_BUFFER_BYTES = 64 * 1024

type CopyBudget = { bytes: number; files: number }
type ManifestEntry = { byteCount: number; digest: string }
type BaseManifest = { files: Record<string, ManifestEntry>; version: 1 }
type WorkspaceChange = {
  base?: ManifestEntry
  draft?: ManifestEntry
  kind: 'created' | 'deleted' | 'modified'
  path: string
}
export type SandboxPromotionManifest = {
  changes: WorkspaceChange[]
  manifestDigest: string
  protocolVersion: 1
  runId: string
}

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
  return { baseManifest: resolve(root, 'base-manifest.json'), parent, root, workspace: resolve(root, 'workspace') }
}

const digest = (value: Buffer | string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

const relativeManifestPath = (workspace: string, path: string): string =>
  relative(workspace, path).split(sep).join('/')

const copyFileWithoutFollowingLinks = async (
  source: string,
  destination: string,
  budget: CopyBudget,
): Promise<ManifestEntry> => {
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
      const hasher = createHash('sha256')
      let position = 0
      while (true) {
        const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break
        let written = 0
        hasher.update(buffer.subarray(0, bytesRead))
        while (written < bytesRead) {
          const write = await destinationHandle.write(buffer, written, bytesRead - written, position + written)
          written += write.bytesWritten
        }
        position += bytesRead
      }
      await destinationHandle.sync()
      return { byteCount: info.size, digest: `sha256:${hasher.digest('hex')}` }
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
  baseFiles: Record<string, ManifestEntry>,
  sourceRoot: string,
): Promise<void> => {
  const info = await lstat(source)
  if (info.isSymbolicLink()) {
    throw new WorkspacePathError('Sandbox sources may not contain symbolic links.')
  }
  if (info.isDirectory()) {
    await mkdir(destination, { mode: 0o700 })
    const entries = await readdir(source, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      await copyTreeWithoutLinks(
        resolve(source, entry.name),
        resolve(destination, entry.name),
        budget,
        baseFiles,
        sourceRoot,
      )
    }
    return
  }
  if (info.isFile()) {
    baseFiles[relativeManifestPath(sourceRoot, source)] = await copyFileWithoutFollowingLinks(
      source,
      destination,
      budget,
    )
    return
  }
  throw new WorkspacePathError('Sandbox sources may not contain special files.')
}

const parseBaseManifest = (value: unknown): BaseManifest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspacePathError('The executor sandbox base manifest is invalid.')
  }
  const manifest = value as { files?: unknown; version?: unknown }
  if (manifest.version !== 1 || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new WorkspacePathError('The executor sandbox base manifest is invalid.')
  }
  const files: Record<string, ManifestEntry> = {}
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (
      path.length === 0
      || path.length > 1_024
      || path.includes('..')
      || !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || !Number.isInteger((entry as ManifestEntry).byteCount)
      || (entry as ManifestEntry).byteCount < 0
      || !/^sha256:[a-f0-9]{64}$/.test((entry as ManifestEntry).digest)
    ) {
      throw new WorkspacePathError('The executor sandbox base manifest is invalid.')
    }
    files[path] = entry as ManifestEntry
    if (Object.keys(files).length > MAX_SOURCE_FILES) {
      throw new WorkspacePathError('The executor sandbox base manifest is invalid.')
    }
  }
  return { files, version: 1 }
}

const readBaseManifest = async (path: string): Promise<BaseManifest> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink > 1 || info.size > 4 * 1024 * 1024) {
      throw new WorkspacePathError('The executor sandbox base manifest is invalid.')
    }
    const bytes = Buffer.allocUnsafe(info.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== bytes.byteLength) throw new WorkspacePathError('The executor sandbox base manifest is invalid.')
    try {
      return parseBaseManifest(JSON.parse(bytes.toString('utf8')))
    } catch (error) {
      if (error instanceof WorkspacePathError) throw error
      throw new WorkspacePathError('The executor sandbox base manifest is invalid.')
    }
  } finally {
    await handle.close()
  }
}

const workspaceManifest = async (workspace: string): Promise<Record<string, ManifestEntry>> => {
  const files: Record<string, ManifestEntry> = {}
  const walk = async (path: string): Promise<void> => {
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      throw new WorkspacePathError('Sandbox workspaces may not contain symbolic links.')
    }
    if (info.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true })
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        await walk(resolve(path, entry.name))
      }
      return
    }
    if (!info.isFile() || info.nlink > 1) {
      throw new WorkspacePathError('Sandbox workspaces may contain only non-linked regular files.')
    }
    if (Object.keys(files).length >= MAX_SOURCE_FILES) {
      throw new WorkspacePathError('The sandbox workspace exceeds its storage limit.')
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const current = await handle.stat()
      if (!current.isFile() || current.nlink > 1 || current.size !== info.size) {
        throw new WorkspacePathError('The sandbox workspace changed during review.')
      }
      const hasher = createHash('sha256')
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
      let offset = 0
      while (offset < current.size) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset)
        if (bytesRead === 0) throw new WorkspacePathError('The sandbox workspace changed during review.')
        hasher.update(buffer.subarray(0, bytesRead))
        offset += bytesRead
      }
      files[relativeManifestPath(workspace, path)] = {
        byteCount: current.size,
        digest: `sha256:${hasher.digest('hex')}`,
      }
    } finally {
      await handle.close()
    }
  }
  await walk(workspace)
  return files
}

const changesFrom = (base: BaseManifest, current: Record<string, ManifestEntry>): WorkspaceChange[] => {
  const paths = [...new Set([...Object.keys(base.files), ...Object.keys(current)])].sort()
  const changes: WorkspaceChange[] = []
  for (const path of paths) {
    const before = base.files[path]
    const after = current[path]
    if (!before && after) changes.push({ draft: after, kind: 'created', path })
    else if (before && !after) changes.push({ base: before, kind: 'deleted', path })
    else if (before && after && (before.digest !== after.digest || before.byteCount !== after.byteCount)) {
      changes.push({ base: before, draft: after, kind: 'modified', path })
    }
  }
  return changes
}

const scratchUsage = async (root: string): Promise<CopyBudget> => {
  const budget: CopyBudget = { bytes: 0, files: 0 }
  const walk = async (path: string): Promise<void> => {
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      throw new WorkspacePathError('Sandbox workspaces may not contain symbolic links.')
    }
    if (info.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true })
      for (const entry of entries) await walk(resolve(path, entry.name))
      return
    }
    if (!info.isFile() || info.nlink > 1) {
      throw new WorkspacePathError('Sandbox workspaces may contain only non-linked regular files.')
    }
    budget.files += 1
    budget.bytes += info.size
    if (budget.files > MAX_SOURCE_FILES || budget.bytes > MAX_SCRATCH_BYTES) {
      throw new WorkspacePathError('The sandbox workspace exceeds its storage limit.')
    }
  }
  await walk(root)
  return budget
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
      const base: BaseManifest = { files: {}, version: 1 }
      await copyTreeWithoutLinks(
        source,
        resolve(staging, 'workspace'),
        { bytes: 0, files: 0 },
        base.files,
        source,
      )
      await writeAll(resolve(staging, 'base-manifest.json'), canonicalExecutorJson(base))
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

/**
 * Returns the exact bounded delta between a run's COW snapshot and its draft.
 * This is a review-only primitive: it never opens or mutates the paired root.
 */
export const reviewSandboxWorkspace = async (
  stateDir: string,
  runId: string,
): Promise<Record<string, unknown>> => {
  const manifest = await promotionManifestForSandbox(stateDir, runId)
  const changes = manifest.changes.map(({ base, draft, kind, path }) => ({
    byteCount: draft?.byteCount ?? base!.byteCount,
    kind,
    path,
  }))
  const result = {
    changeCount: changes.length,
    changes,
    manifestDigest: manifest.manifestDigest,
    success: true,
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_REVIEW_RESULT_BYTES) {
    return {
      changeCount: changes.length,
      code: 'EXECUTOR_REVIEW_TOO_LARGE',
      success: false,
    }
  }
  return result
}

/**
 * Reconstructs the exact, content-hash-bound manifest that a future native
 * promotion helper must verify. This does not open the paired host root and
 * never leaves the daemon; only its digest is included in review receipts.
 */
export const promotionManifestForSandbox = async (
  stateDir: string,
  runId: string,
): Promise<SandboxPromotionManifest> => {
  const paths = await sandboxPaths(stateDir, runId)
  await assertOrdinaryDirectory(paths.root, 'The executor sandbox is unavailable.')
  const workspace = await configureOrdinaryDirectory(paths.workspace, 'The executor sandbox workspace')
  const [base, current] = await Promise.all([
    readBaseManifest(paths.baseManifest),
    workspaceManifest(workspace),
  ])
  const changes = changesFrom(base, current)
  if (changes.length > MAX_REVIEW_CHANGES) {
    throw new WorkspacePathError('The executor sandbox change set exceeds the review limit.')
  }
  const unsigned = {
    changes,
    protocolVersion: 1 as const,
    runId: RunIdSchema.parse(runId),
  }
  return {
    ...unsigned,
    manifestDigest: digest(canonicalExecutorJson(unsigned)),
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
  let existingBytes = 0
  let isNewFile = true
  try {
    const existing = await lstat(destination.path)
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new WorkspacePathError('The sandbox destination must be a regular file.')
    }
    if (args.overwrite !== true) {
      throw new WorkspacePathError('The sandbox destination already exists.')
    }
    existingBytes = existing.size
    isNewFile = false
  } catch (error) {
    if (!missing(error)) throw error
  }
  const usage = await scratchUsage(workspace)
  const nextBytes = usage.bytes - existingBytes + Buffer.byteLength(args.content, 'utf8')
  const nextFiles = usage.files + (isNewFile ? 1 : 0)
  if (nextBytes > MAX_SCRATCH_BYTES || nextFiles > MAX_SOURCE_FILES) {
    throw new WorkspacePathError('The sandbox workspace exceeds its storage limit.')
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
