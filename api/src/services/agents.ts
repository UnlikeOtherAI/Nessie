// Agent services. Creation, binding, and the record mapper are shared with the
// worker (`@nessie/team-admin`) because the personal assistant's
// `agent_create` / `agent_bind_channel` tools must write exactly what the
// routes write; the read model and the update/clone paths stay API-side.
// Callers that only need the `@nessie/team-admin` names import the package
// directly.
export * from './agent-management.js'
export * from './agent-read-model.js'
