import type { ScopeAvailability } from './availability.js'

type ExecutorScopeFacts = {
  projectId: string | null
  privateAssignments: Array<{
    agentId: string | null
    principalKind: 'user' | 'agent'
    role: 'use' | 'admin'
    userId: string | null
  }>
  scopeKind: 'private' | 'project' | 'organization'
}

type RunScopeFacts = {
  projectId: string | null
  projectMember: boolean
}

/**
 * This is the structural scope portion of availability. The caller supplies
 * durable membership facts; no session claim or model-provided scope narrows
 * or expands the decision.
 */
export const resolveExecutorScopeFacts = (
  executor: ExecutorScopeFacts,
  actorUserId: string,
  agentId: string,
  context: RunScopeFacts,
): ScopeAvailability => {
  if (executor.scopeKind === 'private') {
    const human = executor.privateAssignments.find(
      (assignment) => assignment.principalKind === 'user' && assignment.userId === actorUserId,
    )
    return {
      agentAssigned: executor.privateAssignments.some(
        (assignment) => assignment.principalKind === 'agent' && assignment.agentId === agentId,
      ),
      humanAssignment: human?.role ?? 'none',
      kind: 'private',
    }
  }
  if (executor.scopeKind === 'project') {
    return {
      humanProjectEntitled: context.projectMember,
      kind: 'project',
      runProjectMatches: context.projectId === executor.projectId,
    }
  }
  return { humanOrganizationEntitled: true, kind: 'organization' }
}
