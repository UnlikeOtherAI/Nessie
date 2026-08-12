import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, unlink } from 'node:fs/promises'

import { canonicalExecutorJson, RunIdSchema } from '@nessie/schemas'

import { ensureSandboxWorkspace, sandboxPaths } from './sandbox-workspace.js'
import { WorkspacePathError, configureOrdinaryDirectory } from './workspace-paths.js'

type GuestLeaseRecord = {
  bindingFence: string
  commandId: string
  leaseId: string
  runId: string
  version: 1
}

export type GuestWorkspaceLease = {
  bindingFence: string
  commandId: string
  leaseId: string
  runId: string
  workspace: string
}

const missing = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')

const parseLease = (value: unknown): GuestLeaseRecord => {
  if (
    !value || typeof value !== 'object' || Array.isArray(value)
    || typeof (value as Record<string, unknown>).bindingFence !== 'string'
    || typeof (value as Record<string, unknown>).commandId !== 'string'
    || typeof (value as Record<string, unknown>).leaseId !== 'string'
    || typeof (value as Record<string, unknown>).runId !== 'string'
    || (value as Record<string, unknown>).version !== 1
  ) {
    throw new WorkspacePathError('The executor guest lease is malformed.')
  }
  const record = value as GuestLeaseRecord
  RunIdSchema.parse(record.runId)
  if (!/^[1-9][0-9]*$/.test(record.bindingFence) || !UUID_PATTERN.test(record.commandId)) {
    throw new WorkspacePathError('The executor guest lease is malformed.')
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.leaseId)) {
    throw new WorkspacePathError('The executor guest lease is malformed.')
  }
  return record
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const writeLease = async (path: string, record: GuestLeaseRecord): Promise<void> => {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const value = Buffer.from(canonicalExecutorJson(record), 'utf8')
    let offset = 0
    while (offset < value.byteLength) {
      const result = await handle.write(value, offset, value.byteLength - offset, offset)
      offset += result.bytesWritten
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const readLease = async (path: string): Promise<GuestLeaseRecord> => {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new WorkspacePathError('The executor guest lease is unavailable.')
  }
  try {
    return parseLease(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (error instanceof WorkspacePathError) throw error
    throw new WorkspacePathError('The executor guest lease is malformed.')
  }
}

/**
 * Creates the sole local authority to expose a COW draft to a guest VM. It
 * never accepts a host path: the path is derived after creating the exact
 * server-run COW workspace. The durable marker prevents a concurrent stop from
 * erasing that draft while a separately spawned VM still has it mounted.
 */
export const createGuestWorkspaceLease = async (
  stateDir: string,
  workspaceRoot: string,
  input: { bindingFence: string; commandId: string; runId: string },
): Promise<GuestWorkspaceLease> => {
  const parsedRunId = RunIdSchema.parse(input.runId)
  if (!/^[1-9][0-9]*$/.test(input.bindingFence) || !UUID_PATTERN.test(input.commandId)) {
    throw new WorkspacePathError('The executor guest lease identity is invalid.')
  }
  const workspace = await ensureSandboxWorkspace(stateDir, workspaceRoot, parsedRunId)
  const paths = await sandboxPaths(stateDir, parsedRunId)
  await configureOrdinaryDirectory(paths.root, 'The executor sandbox')
  const record: GuestLeaseRecord = {
    bindingFence: input.bindingFence,
    commandId: input.commandId,
    leaseId: randomUUID(),
    runId: parsedRunId,
    version: 1,
  }
  try {
    await writeLease(paths.guestLease, record)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      throw new WorkspacePathError('The executor sandbox already has an active guest lease.')
    }
    throw error
  }
  return {
    bindingFence: record.bindingFence,
    commandId: record.commandId,
    leaseId: record.leaseId,
    runId: record.runId,
    workspace,
  }
}

/** Only the holder of the exact durable lease can unblock sandbox teardown. */
export const releaseGuestWorkspaceLease = async (stateDir: string, lease: GuestWorkspaceLease): Promise<void> => {
  const runId = RunIdSchema.parse(lease.runId)
  const paths = await sandboxPaths(stateDir, runId)
  let stored: GuestLeaseRecord
  try {
    stored = await readLease(paths.guestLease)
  } catch (error) {
    if (missing(error)) throw new WorkspacePathError('The executor guest lease is unavailable.')
    throw error
  }
  if (
    stored.runId !== runId
    || stored.leaseId !== lease.leaseId
    || stored.commandId !== lease.commandId
    || stored.bindingFence !== lease.bindingFence
  ) {
    throw new WorkspacePathError('The executor guest lease does not match this sandbox.')
  }
  await unlink(paths.guestLease)
}

/**
 * Release this exact lease when it is still present. Guest process cleanup and
 * a caller recovering from a failed start can race here, but neither may
 * remove a newer lease: a missing marker is already clean, while a different
 * marker still fails closed in `releaseGuestWorkspaceLease`.
 */
export const releaseGuestWorkspaceLeaseIfCurrent = async (
  stateDir: string,
  lease: GuestWorkspaceLease,
): Promise<boolean> => {
  try {
    await releaseGuestWorkspaceLease(stateDir, lease)
    return true
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

/** Re-read durable state before a VM process receives the COW directory. */
export const assertGuestWorkspaceLeaseCurrent = async (
  stateDir: string,
  lease: GuestWorkspaceLease,
): Promise<void> => {
  const runId = RunIdSchema.parse(lease.runId)
  const paths = await sandboxPaths(stateDir, runId)
  const stored = await readLease(paths.guestLease)
  if (
    stored.runId !== runId
    || stored.leaseId !== lease.leaseId
    || stored.commandId !== lease.commandId
    || stored.bindingFence !== lease.bindingFence
  ) {
    throw new WorkspacePathError('The executor guest lease does not match this sandbox.')
  }
  const workspace = await configureOrdinaryDirectory(paths.workspace, 'The executor sandbox workspace')
  if (workspace !== lease.workspace) {
    throw new WorkspacePathError('The executor guest workspace has changed.')
  }
}
