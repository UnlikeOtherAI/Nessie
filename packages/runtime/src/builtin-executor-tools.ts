import type { BuiltinToolDefinition } from './builtin-tools-types.js'

const UUID = { type: 'string', format: 'uuid' }

export const EXECUTOR_LIST_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'executor_list',
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
  summary,
  label,
  description:
    `Prepare a ${action} action for an executor. The user must review and confirm the exact action in Executors; `
    + 'this assistant cannot apply it.',
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
  summary: 'Prepare a local executor-policy revision change for confirmation.',
  label: 'Prepare Executor Local Policy Review',
  description:
    'Prepare activation or disablement of one signed local executor-policy revision. The requesting '
    + 'user must inspect and confirm it in Executors; activation requires fresh verification and this assistant cannot apply it.',
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
  summary: 'Prepare an executor operation allow or deny for confirmation.',
  label: 'Prepare Executor Agent Access',
  description:
    'Prepare one exact allow or deny for one agent and executor operation. The user must review and '
    + 'confirm it; an agent can never grant executor access to itself or another agent.',
  parameters: {
    type: 'object',
    properties: {
      executorId: UUID,
      agentId: UUID,
      operationKey: {
        type: 'string',
        enum: [
          'file.list', 'file.read', 'file.write', 'command.run', 'browser.open',
          'browser.observe', 'browser.act', 'workspace.review', 'workspace.promote', 'sandbox.stop',
          'coding.launch', 'coding.attach', 'coding.observe', 'coding.prompt',
          'coding.interrupt', 'coding.close',
        ],
      },
      state: { type: 'string', enum: ['allowed', 'denied'] },
    },
    required: ['executorId', 'agentId', 'operationKey', 'state'],
  },
  safe: false,
  personalAssistantOnly: true,
}

export const EXECUTOR_PRIVATE_ASSIGNMENT_PREPARE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'executor_private_assignment_prepare',
  summary: 'Prepare a private executor assignment change for confirmation.',
  label: 'Prepare Private Executor Assignment',
  description:
    'Prepare an exact private-executor assignment change for one named user or agent. The user must '
    + 'review and confirm it with fresh verification; agents never administer this roster.',
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

export const EXECUTOR_WORKSPACE_PROMOTION_PREPARE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'executor_workspace_promotion_prepare',
  summary: 'Prepare reviewed executor workspace promotion for confirmation.',
  label: 'Prepare Reviewed Workspace Promotion',
  description:
    'Prepare the requesting user’s own reviewed executor draft for a host-workspace promotion. '
    + 'The user must inspect and password-confirm the exact manifest in Executors; this assistant cannot write the host workspace.',
  parameters: {
    type: 'object',
    properties: { reviewCommandId: UUID },
    required: ['reviewCommandId'],
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
  EXECUTOR_PRIVATE_ASSIGNMENT_PREPARE_TOOL_DEFINITION,
  EXECUTOR_WORKSPACE_PROMOTION_PREPARE_TOOL_DEFINITION,
]
