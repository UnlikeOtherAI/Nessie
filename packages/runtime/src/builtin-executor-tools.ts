import type { BuiltinToolDefinition } from './builtin-tools-types.js'
import {
  IMPLEMENTED_EXECUTOR_OPERATION_KEYS,
  STANDING_POLICY_ANY_COMMAND_OPTION,
  STANDING_POLICY_LIMIT_CEILINGS,
  STANDING_POLICY_LIMIT_DEFAULTS,
} from '@nessie/schemas'

const UUID = { type: 'string', format: 'uuid' }

export const EXECUTOR_LIST_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'executor_list',
  category: 'executors',
  summary: 'List paired executors available to the requesting user.',
  label: 'Executor List',
  description:
    'List paired executors you can discover, with scope, profile, pairing, and readiness status. '
    + 'Private executors outside your assignment are never returned.',
  parameters: { type: 'object', properties: {} },
  safe: true,
  personalAssistantOnly: true,
}

export const EXECUTOR_INSPECT_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'executor_inspect',
  category: 'executors',
  summary: 'Inspect a reachable executor’s safe capabilities and scope.',
  label: 'Executor Inspect',
  description:
    'Inspect one executor you can discover. Returns its safe capability and scope summary, never '
    + 'another person’s private assignments, local paths, credentials, or raw session output.',
  parameters: {
    type: 'object',
    properties: { executorId: UUID },
    required: ['executorId'],
  },
  safe: true,
  personalAssistantOnly: true,
}

export const EXECUTOR_PAIR_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'executor_pair',
  category: 'executors',
  summary: 'Open the setup surface for pairing an executor.',
  label: 'Pair Executor',
  description:
    'Open the paired-executor setup surface. A user selects the immutable scope and exact private '
    + 'assignments there, then the companion performs cryptographic pairing; this assistant cannot pair a machine itself.',
  parameters: { type: 'object', properties: {} },
  safe: false,
  personalAssistantOnly: true,
}

const lifecycleTool = (
  id: 'executor_pause' | 'executor_drain' | 'executor_revoke',
  label: string,
  action: string,
  summary: string,
): BuiltinToolDefinition => ({
  id,
  category: 'executors',
  summary,
  label,
  description:
    `Prepare a ${action} action for an executor. It posts a confirmation card in this conversation; `
    + 'the user reviews and confirms the exact action from it. This assistant cannot apply it.',
  parameters: {
    type: 'object',
    properties: { executorId: UUID },
    required: ['executorId'],
  },
  safe: false,
  personalAssistantOnly: true,
})

export const EXECUTOR_PAUSE_TOOL_DEFINITION = lifecycleTool(
  'executor_pause',
  'Pause Executor',
  'pause',
  'Prepare an executor pause for user confirmation.',
)
export const EXECUTOR_DRAIN_TOOL_DEFINITION = lifecycleTool(
  'executor_drain',
  'Drain Executor',
  'drain',
  'Prepare executor draining for user confirmation.',
)
export const EXECUTOR_REVOKE_TOOL_DEFINITION = lifecycleTool(
  'executor_revoke',
  'Revoke Executor',
  'irreversible revoke',
  'Prepare irreversible executor revocation for user confirmation.',
)

export const EXECUTOR_DESCRIPTOR_REVIEW_PREPARE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'executor_descriptor_review_prepare',
  category: 'executors',
  summary: 'Prepare a local executor-policy revision change for confirmation.',
  label: 'Prepare Executor Local Policy Review',
  description:
    'Prepare activation or disablement of one signed local executor-policy revision. The requesting '
    + 'user inspects and confirms it from the confirmation card it posts in this conversation; '
    + 'activation requires fresh verification and this assistant cannot apply it.',
  parameters: {
    type: 'object',
    properties: {
      executorId: UUID,
      revision: { type: 'integer', minimum: 1 },
      status: { type: 'string', enum: ['active', 'disabled'] },
    },
    required: ['executorId', 'revision', 'status'],
  },
  safe: false,
  personalAssistantOnly: true,
}

export const EXECUTOR_AGENT_ACCESS_PREPARE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'executor_agent_access_prepare',
  category: 'executors',
  summary: 'Prepare an executor operation allow or deny for confirmation.',
  label: 'Prepare Executor Agent Access',
  description:
    'Prepare one exact allow or deny for one agent and executor operation. The user reviews and '
    + 'confirms it from the confirmation card it posts in this conversation; an agent can never grant '
    + 'executor access to itself or another agent.',
  parameters: {
    type: 'object',
    properties: {
      executorId: UUID,
      agentId: UUID,
      operationKey: {
        type: 'string',
        enum: [...IMPLEMENTED_EXECUTOR_OPERATION_KEYS],
      },
      state: { type: 'string', enum: ['allowed', 'denied'] },
    },
    required: ['executorId', 'agentId', 'operationKey', 'state'],
  },
  safe: false,
  personalAssistantOnly: true,
}

export const EXECUTOR_AGENT_GRANT_PREPARE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'executor_agent_grant_prepare',
  category: 'executors',
  summary: 'Prepare whole-suite executor access for one agent, for confirmation.',
  label: 'Prepare Executor Agent Grant',
  description:
    'Prepare one allow or deny covering the WHOLE suite an executor offers one named agent: every '
    + 'operation its active reviewed policy names, except workspace.promote, which only a person can '
    + 'issue. There is no per-operation pick here — access to an executor is access to everything on '
    + 'it. It posts a confirmation card in this conversation, where the requesting person reviews and '
    + 'confirms the exact change, and an allow requires fresh account verification; an agent can '
    + 'never grant executor access to itself or to another agent.',
  parameters: {
    type: 'object',
    properties: {
      executorId: UUID,
      agentId: UUID,
      state: { type: 'string', enum: ['allowed', 'denied'] },
    },
    required: ['executorId', 'agentId', 'state'],
  },
  safe: false,
  personalAssistantOnly: true,
}

export const EXECUTOR_PRIVATE_ASSIGNMENT_PREPARE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'executor_private_assignment_prepare',
  category: 'executors',
  summary: 'Prepare a private executor assignment change for confirmation.',
  label: 'Prepare Private Executor Assignment',
  description:
    'Prepare an exact private-executor assignment change for one named user or agent. The user '
    + 'reviews and confirms it with fresh verification from the confirmation card it posts in this '
    + 'conversation; agents never administer this roster.',
  parameters: {
    type: 'object',
    properties: {
      executorId: UUID,
      action: { type: 'string', enum: ['set', 'remove'] },
      principalKind: { type: 'string', enum: ['user', 'agent'] },
      principalId: UUID,
      role: { type: 'string', enum: ['use', 'admin'] },
    },
    required: ['executorId', 'action', 'principalKind', 'principalId'],
  },
  safe: false,
  personalAssistantOnly: true,
}

export const EXECUTOR_TEAM_PROMOTION_PREPARE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'executor_workspace_promotion_prepare',
  category: 'executors',
  summary: 'Prepare reviewed executor team promotion for confirmation.',
  label: 'Prepare Reviewed Team Promotion',
  description:
    'Prepare the requesting user’s own reviewed executor draft for a host-team promotion. '
    + 'It posts a confirmation card in this conversation, where the user inspects and '
    + 'password-confirms the exact manifest; this assistant cannot write the host team.',
  parameters: {
    type: 'object',
    properties: { reviewCommandId: UUID },
    required: ['reviewCommandId'],
  },
  safe: false,
  personalAssistantOnly: true,
}

/**
 * A ticket trigger's standing machine access, as ONE confirmation card
 * (docs/standards/ticket-work.md). PA-only, so it reaches the Agent Designer
 * through its identity-delegated set and never a designed agent — the agent
 * that works the tickets has no way to give itself machines. The handler
 * refuses anyone but the trigger's author, in their own Designer or Personal
 * Assistant conversation, on an interactive turn.
 */
export const EXECUTOR_STANDING_POLICY_PREPARE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'executor_standing_policy_prepare',
  category: 'executors',
  summary: 'Prepare a ticket trigger’s standing machine access as one confirmation card.',
  label: 'Prepare Machine Access',
  description:
    'Prepare standing machine access for a ticket trigger you set up: one or two private machines you paired, '
    + 'whose reviewed coding-sessions bridge lets the trigger’s agent have Claude Code work its tickets as '
    + 'you. It posts ONE confirmation card in this conversation covering the agent’s access to every machine '
    + 'and the policy itself, which you confirm with your password; each machine that cannot take the work is '
    + 'refused with its reason. Only the person who set the trigger up can prepare it.',
  parameters: {
    type: 'object',
    properties: {
      triggerId: { ...UUID, description: 'The ticket trigger, from agent_trigger_create or agent_trigger_list.' },
      executorIds: {
        type: 'array',
        items: UUID,
        minItems: 1,
        maxItems: 2,
        description: 'One or two machines that say "ticket work: yes" in your executor facts.',
      },
      allowAnyCommand: {
        type: 'boolean',
        description: `${STANDING_POLICY_ANY_COMMAND_OPTION} Only when the person asked for exactly that; without it a `
          + 'machine whose Claude Code runs in bypassPermissions is refused.',
      },
      allowedRootNames: {
        type: 'array',
        items: { type: 'string' },
        description: 'The coding roots ticket work may use. Leave out for every root the machines share.',
      },
      limits: {
        type: 'object',
        properties: {
          ticketHours: {
            type: 'number', maximum: STANDING_POLICY_LIMIT_CEILINGS.ticketHours,
            description: `Hours one ticket may stay active (default ${STANDING_POLICY_LIMIT_DEFAULTS.ticketHours}).`,
          },
          ticketUsd: {
            type: 'number', maximum: STANDING_POLICY_LIMIT_CEILINGS.ticketUsd,
            description: `US dollars one ticket may spend (default ${STANDING_POLICY_LIMIT_DEFAULTS.ticketUsd}); `
              + 'each machine’s per-turn budget must not exceed it.',
          },
          dailyUsd: {
            type: 'number', maximum: STANDING_POLICY_LIMIT_CEILINGS.dailyUsd,
            description: `US dollars the trigger’s work may spend a day (default ${STANDING_POLICY_LIMIT_DEFAULTS.dailyUsd}).`,
          },
        },
      },
    },
    required: ['triggerId', 'executorIds'],
  },
  safe: false,
  personalAssistantOnly: true,
}

export const EXECUTOR_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  EXECUTOR_LIST_TOOL_DEFINITION,
  EXECUTOR_INSPECT_TOOL_DEFINITION,
  EXECUTOR_PAIR_TOOL_DEFINITION,
  EXECUTOR_PAUSE_TOOL_DEFINITION,
  EXECUTOR_DRAIN_TOOL_DEFINITION,
  EXECUTOR_REVOKE_TOOL_DEFINITION,
  EXECUTOR_DESCRIPTOR_REVIEW_PREPARE_TOOL_DEFINITION,
  EXECUTOR_AGENT_ACCESS_PREPARE_TOOL_DEFINITION,
  EXECUTOR_AGENT_GRANT_PREPARE_TOOL_DEFINITION,
  EXECUTOR_PRIVATE_ASSIGNMENT_PREPARE_TOOL_DEFINITION,
  EXECUTOR_TEAM_PROMOTION_PREPARE_TOOL_DEFINITION,
  EXECUTOR_STANDING_POLICY_PREPARE_TOOL_DEFINITION,
]
