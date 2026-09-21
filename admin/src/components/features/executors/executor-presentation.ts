import type { ExecutorRecordResponse, ExecutorStatus, ImplementedExecutorOperationKey } from '@nessie/schemas'
import type { PillTone } from '../../primitives/Pill'

// One reading of an executor's status and scope, shared by the list row, the
// detail header and anything else that names them. They used to be spelled
// twice — a `statusClass` ternary chain on the list and a plain `outline` chip
// on the detail panel — so the same executor read "online" in green on one
// screen and in grey on the other.

export const EXECUTOR_STATUS_LABELS: Record<ExecutorStatus, string> = {
  draining: 'Draining',
  error: 'Error',
  offline: 'Offline',
  online: 'Online',
  paused: 'Paused',
  pending_pairing: 'Pending pairing',
  revoked: 'Revoked',
}

export const executorStatusTone = (status: ExecutorStatus): PillTone => {
  switch (status) {
    case 'online':
      return 'success'
    case 'pending_pairing':
    case 'draining':
    case 'paused':
      return 'warning'
    case 'revoked':
    case 'error':
      return 'danger'
    case 'offline':
      return 'muted'
  }
}

export const executorScopeLabel = (executor: ExecutorRecordResponse): string =>
  executor.scope.kind === 'private'
    ? 'Private'
    : executor.scope.kind === 'project'
      ? 'Project'
      : 'Organization'

/** The sentence under the executor's name: who this machine is reachable by. */
export const executorScopeSummary = (executor: ExecutorRecordResponse): string =>
  executor.scope.kind === 'private'
    ? 'Private machine'
    : executor.scope.kind === 'project'
      ? 'Project machine'
      : 'Organisation machine'

export const executorProfilesLabel = (executor: ExecutorRecordResponse): string =>
  executor.profiles.join(', ') || 'Awaiting descriptor review'

export const EXECUTOR_OPERATION_LABELS: Record<ImplementedExecutorOperationKey, string> = {
  'file.list': 'Browse files',
  'file.read': 'Read files',
  'file.write': 'Edit draft copies',
  'command.run': 'Run permitted programs',
  'browser.open': 'Open an isolated browser',
  'browser.observe': 'Read the isolated browser',
  'browser.act': 'Use the isolated browser',
  'browser.connected.open': 'Connect an approved browser tab',
  'browser.connected.observe': 'Read the connected tab',
  'browser.connected.act': 'Use the connected tab',
  'coding.launch': 'Start a coding session',
  'coding.observe': 'Check coding progress',
  'workspace.review': 'Review draft changes',
  'workspace.promote': 'Apply approved changes to the machine',
  'sandbox.stop': 'Stop a work session',
  'mcp.tools': 'Discover local app tools',
  'mcp.call': 'Use local app tools',
}

export const executorOperationLabel = (key: string): string =>
  EXECUTOR_OPERATION_LABELS[key as ImplementedExecutorOperationKey] ?? key
