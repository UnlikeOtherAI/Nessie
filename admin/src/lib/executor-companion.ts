import { invoke } from '@tauri-apps/api/core'
import { isDesktopApp } from './desktop'

export type ExecutorCompanionStatus = {
  daemonStatus: 'awaiting_confirmation' | 'running' | 'stopped' | 'stopping'
  executorId: string
  /** Locally read descriptor policy. Never fetched from or sent to Nessie. */
  operationKeys: string[]
  workspaceConfigured: boolean
  /** Basename-only local display label. The full path never enters the web app. */
  workspaceLabel: string
}

/**
 * Why this device can or cannot host an executor. The command answers with a
 * state instead of failing, so the Executors page can tell the truth about the
 * computer a person is standing at rather than rendering nothing — see
 * docs/plans/2026-09-01-linux-desktop-delivery.md → "The Executors page tells
 * the truth about this device".
 */
export type ExecutorCompanionAvailability =
  | 'available'
  | 'runtime_missing'
  | 'unsigned_release'
  | 'unsupported_platform'
  /** Pairing works, but with no virtualization only the COW workspace bundle. */
  | 'workspace_only'

/**
 * The Nessie Executor menu bar app, as one per-Mac fact rather than a
 * per-executor one. Nessie Desktop nests a copy of that app inside its own
 * bundle, so a Mac with Desktop installs nothing extra to run an executor; once
 * that app is supervising the daemon it owns this Mac, and Desktop says so
 * instead of offering a start button that would race it for the daemon lease.
 */
export type ExecutorMenuBarCompanion = {
  /** There is a copy Desktop can open: its nested helper, or a verified install. */
  openable: boolean
  /** That app is running this Mac's executor daemon right now. */
  supervising: boolean
}

export type ExecutorCompanionStatusResponse = {
  availability: ExecutorCompanionAvailability
  executors: ExecutorCompanionStatus[]
  /**
   * Optional because the shell ships separately from this admin. A Nessie
   * Desktop built before the menu bar app existed answers without this field,
   * and the hosted admin it loads is always the newest one — so a required
   * field here would be a crash on somebody else's release schedule.
   */
  menuBar?: ExecutorMenuBarCompanion
  platform: 'linux' | 'macos' | 'windows'
  /** Person-readable, names the remedy, and carries no local path or secret. */
  reason: string
}

type PairExecutorWithCompanionInput = {
  apiBaseUrl: string
  challenge: string
  enrollmentId: string
  executorId: string
}

const invokeCompanion = async <Result>(command: string, payload?: Record<string, unknown>): Promise<Result> => {
  if (!isDesktopApp()) throw new Error('Nessie Desktop is not available in this browser.')
  return invoke<Result>(command, payload)
}

export const executorCompanionStatus = (): Promise<ExecutorCompanionStatusResponse> =>
  invokeCompanion('executor_companion_status')

export const pairExecutorWithCompanion = (
  input: PairExecutorWithCompanionInput,
): Promise<ExecutorCompanionStatus> =>
  invokeCompanion('executor_companion_pair', {
    apiBaseUrl: input.apiBaseUrl,
    challenge: input.challenge,
    enrollmentId: input.enrollmentId,
    executorId: input.executorId,
  })

export const startExecutorWithCompanion = (
  executorId: string,
): Promise<ExecutorCompanionStatus> =>
  invokeCompanion('executor_companion_start', { executorId })

export const stopExecutorWithCompanion = (
  executorId: string,
): Promise<ExecutorCompanionStatus> =>
  invokeCompanion('executor_companion_stop', { executorId })

export const configureExecutorWorkspaceWithCompanion = (
  executorId: string,
  operationKeys: string[],
): Promise<ExecutorCompanionStatus> =>
  invokeCompanion('executor_companion_configure_workspace', { executorId, operationKeys })

export const changeExecutorWorkspaceWithCompanion = (
  executorId: string,
  operationKeys: string[],
): Promise<ExecutorCompanionStatus> =>
  invokeCompanion('executor_companion_change_workspace', { executorId, operationKeys })

export const forgetExecutorWithCompanion = (
  executorId: string,
): Promise<void> => invokeCompanion('executor_companion_forget', { executorId })

/**
 * Hands this Mac over to the menu bar app. The shell chooses which copy to open
 * and verifies an install it did not ship before launching it; nothing about
 * that choice is made here, because a renderer cannot check a code signature.
 */
export const openExecutorMenuBarApp = (): Promise<void> =>
  invokeCompanion('executor_companion_open_menu_bar_app')

/** What a shell that predates the menu bar app is taken to have said. */
export const NO_MENU_BAR_COMPANION: ExecutorMenuBarCompanion = {
  openable: false,
  supervising: false,
}
