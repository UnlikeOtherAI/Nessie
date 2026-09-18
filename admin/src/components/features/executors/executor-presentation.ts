import type { ExecutorRecordResponse, ExecutorStatus } from '@nessie/schemas'
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
    ? 'Private — only exact assigned people and agents can use it.'
    : executor.scope.kind === 'project'
      ? `Project — eligible only for runs in project ${executor.scope.projectId}.`
      : 'Organization — available only to entitled organization work.'

export const executorProfilesLabel = (executor: ExecutorRecordResponse): string =>
  executor.profiles.join(', ') || 'Awaiting descriptor review'
