import type { BuiltinToolDefinition } from './builtin-tools-types.js'

const LIFECYCLE_TOOL_INPUTS: Array<[string, string, string, string[]]> = [
  ['agent_unbind_channel', 'Unbind Agent', 'Remove an agent from a channel.', ['agentId', 'channelId']],
  ['agent_trigger_list', 'List Agent Triggers', 'List an agent’s triggers and exact trigger ids.', ['agentId']],
  ['agent_trigger_update', 'Update Agent Trigger', 'Update a trigger’s name, description, or running state.', ['triggerId']],
  ['agent_trigger_delete', 'Delete Agent Trigger', 'Delete a trigger that has no delivery history.', ['triggerId']],
  ['agent_delete', 'Delete Agent', 'Soft-delete an agent and revoke every standing capability.', ['agentId']],
]

export const LIFECYCLE_TOOL_DEFINITIONS: BuiltinToolDefinition[] =
  LIFECYCLE_TOOL_INPUTS.map(([id, label, summary, required]) => ({
  id,
  category: 'agents',
  summary,
  label,
  personalAssistantOnly: true,
  identityDelegatedOnly: true,
  description: `${summary} Available to the Agent Designer for an organisation owner acting with a live member identity.`,
  parameters: { type: 'object' as const, properties: Object.fromEntries(required.map((key) => [key, { type: 'string' }])), required },
  safe: id === 'agent_trigger_list',
}))

const updateLifecycleTool = LIFECYCLE_TOOL_DEFINITIONS.find((tool) => tool.id === 'agent_trigger_update')!
updateLifecycleTool.parameters.properties = {
  triggerId: { type: 'string' },
  config: { type: 'object' },
  description: { type: 'string' },
  enabled: { type: 'boolean' },
  name: { type: 'string' },
  nextRunAt: { type: 'string' },
  status: { type: 'string', enum: ['active', 'paused', 'error', 'needs_reauthorization'] },
  targetChannelId: { type: 'string' },
  targetThreadId: { type: 'string' },
}
