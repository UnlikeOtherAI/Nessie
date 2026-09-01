import { invoke } from '@tauri-apps/api/core'
import { isDesktopApp } from './desktop'

export type ExecutorCompanionStatus = {
  daemonStatus: 'awaiting_confirmation' | 'running' | 'stopped' | 'stopping'
  executorId: string
  workspaceConfigured: boolean
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

export type ExecutorCompanionStatusResponse = {
  availability: ExecutorCompanionAvailability
  executors: ExecutorCompanionStatus[]
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
