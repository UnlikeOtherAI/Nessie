import type {
  ExecutorAgentOperationGrantState,
  ExecutorAvailabilityReason,
  ExecutorStatus,
} from '@nessie/schemas'

export type PrivateScopeAvailability = {
  kind: 'private'
  agentAssigned: boolean
  humanAssignment: 'none' | 'use' | 'admin'
}

export type ProjectScopeAvailability = {
  kind: 'project'
  humanProjectEntitled: boolean
  runProjectMatches: boolean
}

export type OrganizationScopeAvailability = {
  kind: 'organization'
  humanOrganizationEntitled: boolean
}

export type ScopeAvailability =
  | PrivateScopeAvailability
  | ProjectScopeAvailability
  | OrganizationScopeAvailability

export type ExecutorAvailabilityInput = {
  descriptorApproved: boolean
  executorStatus: ExecutorStatus
  localPolicyAllows: boolean
  logicalToolAllowed: boolean
  operationGrantState: ExecutorAgentOperationGrantState | null
  scope: ScopeAvailability
}

export type ExecutorAvailabilityDecision =
  | { available: true; reason: 'ready' }
  | { available: false; reason: Exclude<ExecutorAvailabilityReason, 'ready'> }

const unavailable = (
  reason: Exclude<ExecutorAvailabilityReason, 'ready'>,
): ExecutorAvailabilityDecision => ({ available: false, reason })

const scopeAllows = (scope: ScopeAvailability): boolean => {
  switch (scope.kind) {
    case 'private':
      return scope.humanAssignment !== 'none' && scope.agentAssigned
    case 'project':
      return scope.humanProjectEntitled && scope.runProjectMatches
    case 'organization':
      return scope.humanOrganizationEntitled
  }
}

const scopeReason = (
  scope: ScopeAvailability,
): Exclude<ExecutorAvailabilityReason, 'ready'> => {
  if (scope.kind === 'private' && scope.humanAssignment === 'none') {
    return 'executor_not_discoverable'
  }
  return 'scope_mismatch'
}

/**
 * The sole pre-binding availability decision. Callers must pass facts resolved
 * from durable records; this function intentionally has no executor ID or
 * caller-controlled selection field.
 */
export const resolveExecutorAvailability = (
  input: ExecutorAvailabilityInput,
): ExecutorAvailabilityDecision => {
  if (input.executorStatus !== 'online') return unavailable('executor_offline')
  if (!input.descriptorApproved) return unavailable('descriptor_unreviewed')
  if (!scopeAllows(input.scope)) return unavailable(scopeReason(input.scope))
  if (input.operationGrantState !== 'allowed') return unavailable('operation_ungranted')
  if (!input.logicalToolAllowed) return unavailable('logical_tool_ungranted')
  if (!input.localPolicyAllows) return unavailable('local_policy_denied')
  return { available: true, reason: 'ready' }
}

/** Only a human private-admin assignment can change a private roster. */
export const canManagePrivateAssignments = (
  assignment: PrivateScopeAvailability['humanAssignment'],
): boolean => assignment === 'admin'
