import { lstat, rm } from 'node:fs/promises'

import { assertOrdinaryDirectory, missing, sandboxPaths } from './sandbox-layout.js'
import { WorkspacePathError, configureOrdinaryDirectory } from './workspace-paths.js'
import { configureWorkspaceRoot } from './workspace.js'

/**
 * A run's sandbox, seen from the daemon: which directory a command works in
 * and when the draft is discarded. Building the snapshot, writing into it, and
 * reviewing it are each their own module; this one re-exports their entry
 * points so the daemon reaches the whole lifecycle through one import.
 */
export { sandboxPaths } from './sandbox-layout.js'
export { promotionManifestForSandbox, reviewSandboxWorkspace } from './sandbox-manifest.js'
export type { SandboxPromotionManifest } from './sandbox-manifest.js'
export { ensureSandboxWorkspace } from './sandbox-snapshot.js'
export { writeSandboxFile } from './sandbox-write.js'

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

/** Stop discards only the exact daemon-owned COW workspace for this run. */
export const stopSandboxWorkspace = async (stateDir: string, runId: string): Promise<boolean> => {
  const paths = await sandboxPaths(stateDir, runId)
  try {
    await assertOrdinaryDirectory(paths.root, 'The executor sandbox is unavailable.')
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
  try {
    const lease = await lstat(paths.guestLease)
    if (lease.isSymbolicLink() || !lease.isFile()) {
      throw new WorkspacePathError('The executor guest lease is unavailable.')
    }
    throw new WorkspacePathError('The executor sandbox has an active guest lease.')
  } catch (error) {
    if (!missing(error)) throw error
  }
  await rm(paths.root, { force: true, recursive: true })
  return true
}
