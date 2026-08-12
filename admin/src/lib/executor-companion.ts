import { invoke } from '@tauri-apps/api/core'
import { isDesktopApp } from './desktop'

export type ExecutorCompanionStatus = {
  daemonStatus: 'awaiting_confirmation' | 'running' | 'stopped' | 'stopping'
  executorId: string
  workspaceConfigured: boolean
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

export const executorCompanionStatus = (): Promise<ExecutorCompanionStatus[]> =>
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
