import { AgentTriggerTypeSchema, type AgentTriggerType } from '@nessie/schemas'

/**
 * Agent trigger types the enum carries before anything may create one.
 *
 * `ticket_changed` and `document_changed` entered the schema first so the
 * ticket-work tables, queue payloads and standard could name them
 * (docs/plans/2026-09-23-ticket-driven-agents, T0), and each was released in
 * the PR that shipped its typed configuration (`AgentTriggerConfigInputSchema`),
 * its server-side resolution and its dispatch: `ticket_changed` in T1,
 * `document_changed` in T2. The list is empty now; it stays as the gate a
 * future type enters the enum through. A row of an unreleased type would be
 * an automation nobody can configure and that never fires, so every
 * agent-trigger create surface refuses it with the one sentence below: the
 * Triggers route and the assistant's `agent_trigger_create` tool, with
 * `createAgentTrigger` refusing it again underneath, and nothing that lists
 * agent trigger types to a person or a model names it. Taking a type off this
 * list is what releases it for agents, in the same change that adds its arm
 * to the typed config union (a test holds the two equal). Workflows are gated
 * separately, by `WORKFLOW_TRIGGER_TYPES`.
 */
export const UNRELEASED_TRIGGER_TYPES: readonly AgentTriggerType[] = []

/** The types a person or a model may give an agent today, in the enum's order. */
export const RELEASED_TRIGGER_TYPES: readonly AgentTriggerType[] = AgentTriggerTypeSchema.options
  .filter((type) => !UNRELEASED_TRIGGER_TYPES.includes(type))

/** The refusal every agent-trigger create surface gives for an unreleased type, or null. */
export const unreleasedTriggerTypeRefusal = (type: AgentTriggerType): string | null =>
  UNRELEASED_TRIGGER_TYPES.includes(type)
    ? `${type} triggers cannot be created yet. Use one of: ${RELEASED_TRIGGER_TYPES.join(', ')}.`
    : null

/**
 * The types a workflow installation may be started by: a permanent allowlist,
 * not a release list. `ticket_changed` and `document_changed` are agent-only
 * whether released or not, because each one wakes an agent bound to its target
 * channel, through a work record and `ticket.work` runs, none of which a
 * workflow has. So releasing a type for agents never opens it here: the
 * workflow-trigger route, `workflow_trigger_create` and `createWorkflowTrigger`
 * all refuse anything outside this list. A new trigger type is agent-only until
 * it is added here deliberately.
 */
export const WORKFLOW_TRIGGER_TYPES: readonly AgentTriggerType[] = [
  'manual',
  'scheduled',
  'webhook',
  'event',
  'interval',
]

/** The refusal every workflow-trigger create surface gives for a type outside the list, or null. */
export const workflowTriggerTypeRefusal = (type: AgentTriggerType): string | null =>
  WORKFLOW_TRIGGER_TYPES.includes(type)
    ? null
    : `${type} triggers start an agent's work, not a workflow. Use one of: ${WORKFLOW_TRIGGER_TYPES.join(', ')}.`
