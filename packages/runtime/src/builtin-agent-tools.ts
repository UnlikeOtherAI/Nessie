import type { BuiltinToolDefinition } from './builtin-tools-types.js'

/**
 * Agent administration the personal assistant can do because its owner can do
 * it by clicking: create an agent, put it in a channel, give it a trigger.
 *
 * Each mirrors one REST route's authorization. `agent_create` is open to any
 * member (its route carries only authentication); `agent_bind_channel` and
 * `agent_trigger_create` are owner-only and say so when a member asks, rather
 * than pretending the capability does not exist.
 */
export const AGENT_ADMIN_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: 'agent_create',
    label: 'Create Agent',
    personalAssistantOnly: true,
    description:
      'Create a new shared agent — a colleague with its own instructions, model, '
      + 'and tool policy — the same record the Agent Designer writes. The agent '
      + 'starts in no channel; an owner puts it to work with agent_bind_channel. '
      + 'Any member can do this. Explicit-grant tools (research, DeepWater) cannot '
      + 'be granted here; they are owner controls.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name for the agent.' },
        role: {
          type: 'string',
          description: 'Short role label, e.g. "researcher" (default "assistant").',
        },
        systemPrompt: {
          type: 'string',
          description: 'The standing instructions that define how this agent works.',
        },
        model: {
          type: 'string',
          description:
            'Model id from the deployment catalogue. Must be sent together with provider.',
        },
        provider: {
          type: 'string',
          description: 'Provider/service id for the model. Must be sent together with model.',
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh'],
          description: 'Reasoning effort. Carries no spend meaning.',
        },
        runLimits: {
          type: 'object',
          description:
            'Optional explicit per-run caps (tokens, tool calls, iterations, wall clock, cost). '
            + 'Omit to use the deployment backstop.',
        },
        toolPolicy: {
          type: 'object',
          description:
            'Optional per-tool allow/deny map, e.g. {"web_search": true}. '
            + 'Explicit-grant tools are rejected.',
        },
      },
      required: ['name'],
    },
    safe: false,
  },
  {
    id: 'agent_bind_channel',
    label: 'Bind Agent To Channel',
    personalAssistantOnly: true,
    description:
      'Put an agent to work in a channel, so it reads and answers there. '
      + 'Organisation owners only, and only in a channel the owner is a member '
      + 'of; a Personal Assistant DM cannot take another agent. Use channel_find '
      + 'for the channelId; agent_create returns the agentId.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The agent to bind.' },
        channelId: { type: 'string', description: 'The channel it should work in.' },
      },
      required: ['agentId', 'channelId'],
    },
    safe: false,
  },
  {
    id: 'agent_trigger_create',
    label: 'Create Agent Trigger',
    personalAssistantOnly: true,
    description:
      'Give ANOTHER agent a trigger: a schedule, an interval, an inbound webhook, '
      + 'an event subscription, or a manual button. Organisation owners only, and '
      + 'the agent must already be bound to the target channel. To schedule '
      + 'yourself instead, use schedule_task — that needs no owner rights.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The agent the trigger fires.' },
        type: {
          type: 'string',
          enum: ['manual', 'scheduled', 'interval', 'webhook', 'event'],
          description: 'Kind of trigger.',
        },
        name: { type: 'string', description: 'Short name shown on the Triggers page.' },
        description: { type: 'string', description: 'What this trigger is for.' },
        enabled: {
          type: 'boolean',
          description: 'Create it paused with false (default true).',
        },
        config: {
          type: 'object',
          description:
            'Type-specific settings: {"cron","timezone","until"} for scheduled, '
            + '{"interval_minutes"} for interval, {"prompt"} for what the agent should do, '
            + '{"eventType"} for event.',
        },
        nextRunAt: {
          type: 'string',
          description: 'ISO 8601 time for the first run (scheduled/interval).',
        },
        targetChannelId: {
          type: 'string',
          description: 'Channel the run posts into. The agent must be bound to it.',
        },
        targetThreadId: {
          type: 'string',
          description: 'Thread the run posts into, instead of the channel default.',
        },
      },
      required: ['agentId', 'type'],
    },
    safe: false,
  },
]
