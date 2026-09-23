import { describeAgentTriggerTypes } from '@nessie/schemas'

import type { BuiltinToolDefinition } from './builtin-tools-types.js'

/**
 * The trigger config prose `agent_trigger_create` and `agent_trigger_update`
 * describe their `config` with, generated from `AgentTriggerConfigInputSchema`
 * rather than written here.
 */
export const AGENT_TRIGGER_CONFIG_PROSE = [
  'Type-specific settings. Each type, and the settings it takes:',
  ...describeAgentTriggerTypes(),
].join('\n')

const LIFECYCLE_TOOL_INPUTS: Array<[string, string, string, string[]]> = [
  ['agent_unbind_channel', 'Unbind Agent', 'Remove an agent from a channel.', ['agentId', 'channelId']],
  ['agent_trigger_list', 'List Agent Triggers', 'List an agent’s triggers, each a link whose last segment is its triggerId.', ['agentId']],
  ['agent_trigger_update', 'Update Agent Trigger', 'Update a trigger’s name, description, config, or running state.', ['triggerId']],
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
  config: {
    type: 'object',
    description: 'Only the settings that change; the rest stay as they are. A ticket_changed change is '
      + `checked again as a whole, and a refusal names the field.\n${AGENT_TRIGGER_CONFIG_PROSE}`,
  },
  description: { type: 'string' },
  enabled: { type: 'boolean' },
  name: { type: 'string' },
  nextRunAt: { type: 'string' },
  status: { type: 'string', enum: ['active', 'paused', 'error', 'needs_reauthorization'] },
  targetChannelId: { type: 'string' },
  targetThreadId: { type: 'string' },
}
