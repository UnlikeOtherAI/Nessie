import { AgentTriggerTypeSchema, type AgentTriggerType } from '@nessie/schemas'

/**
 * Trigger types the enum carries before anything may create one.
 *
 * `ticket_changed` and `document_changed` enter the schema first so the
 * ticket-work tables, queue payloads and standard can name them
 * (docs/plans/2026-09-23-ticket-driven-agents, T0). Their typed configuration,
 * dispatch and editor ship later. A row of either type before then would be an
 * automation nobody can configure and that never fires, so every create
 * surface refuses them with the one sentence below: the Triggers and
 * workflow-trigger routes, and the assistant's `agent_trigger_create` and
 * `workflow_trigger_create` tools. `createAgentTrigger` and
 * `createWorkflowTrigger` refuse them again underneath, and nothing that lists
 * trigger types to a person or a model names them. Taking a type off this list
 * is what releases it.
 */
export const UNRELEASED_TRIGGER_TYPES: readonly AgentTriggerType[] = [
  'ticket_changed',
  'document_changed',
]

/** The types a person or a model may create today, in the enum's order. */
export const RELEASED_TRIGGER_TYPES: readonly AgentTriggerType[] = AgentTriggerTypeSchema.options
  .filter((type) => !UNRELEASED_TRIGGER_TYPES.includes(type))

/** The refusal every create surface gives for an unreleased type, or null. */
export const unreleasedTriggerTypeRefusal = (type: AgentTriggerType): string | null =>
  UNRELEASED_TRIGGER_TYPES.includes(type)
    ? `${type} triggers cannot be created yet. Use one of: ${RELEASED_TRIGGER_TYPES.join(', ')}.`
    : null
