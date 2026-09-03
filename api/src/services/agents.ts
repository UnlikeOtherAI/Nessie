// Agent services. Creation, binding, and the record mapper are shared with the
// worker (`@nessie/team-admin`) because the personal assistant's
// `agent_create` / `agent_bind_channel` tools must write exactly what the
// routes write; the read model and the update/clone paths stay API-side.
export {
  AGENT_BINDING_ERROR_CODES,
  AgentBindingError,
  bindAgentToChannel,
  buildAccessibleChannelWhere,
  buildAccessibleThreadWhere,
  isSystemManagedAgent,
  mapAgentRecord,
  readAgentRunLimits,
  unbindAgentFromChannel,
  type AgentVisibilityScope,
} from '@nessie/team-admin'
export * from './agent-management.js'
export * from './agent-read-model.js'
