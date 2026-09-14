// Team administration keeps this forwarding entry point for API and worker
// callers. Runtime owns the predicate because Knowledge needs the exact same
// decision without introducing a package cycle.
export {
  AGENT_EDIT_AUTHORITY_ERROR_CODES,
  AgentEditAuthorityError,
  assertAgentEditAuthority,
  assertAgentFieldAuthority,
  agentOwnershipState,
  canEditAgent,
  resolveAgentEditAuthority,
  type AgentEditActor,
  type AgentEditAuthority,
  type AgentEditAuthorityErrorCode,
  type AgentEditPatch,
  type AgentOwnershipState,
  type EditableAgentRow,
} from '@nessie/runtime'
