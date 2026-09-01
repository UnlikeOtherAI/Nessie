import type { BuiltinToolDefinition } from './builtin-tools-types.js'

/**
 * Agent administration the personal assistant can do because its owner can do
 * it by clicking: see the agents, create an agent, put it in a channel, give it
 * a trigger.
 *
 * Each mirrors one REST route's authorization. `agent_list` and `agent_create`
 * are open to any member (their routes carry only authentication);
 * `agent_bind_channel` and `agent_trigger_create` are owner-only and say so
 * when a member asks, rather than pretending the capability does not exist.
 *
 * `agent_list` is what makes the other two usable on an agent the user merely
 * named: in the UI an owner picks the agent from a list, and without this the
 * assistant could only act on an agent it had just created itself.
 */
export const AGENT_ADMIN_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: 'agent_list',
    summary: 'List reachable agents and their channel bindings.',
    label: 'List Agents',
    personalAssistantOnly: true,
    description:
      'List the agents you can reach, with the channels each one already works '
      + 'in. This is how an agent NAME becomes the agentId that '
      + 'agent_bind_channel and agent_trigger_create require: call it first '
      + 'whenever the user refers to an existing agent ("put Hardware Watch in '
      + '#ops", "give the reporter a daily schedule") — you only already know an '
      + 'id for an agent you created in this same conversation, so never guess '
      + 'one. Owners see every workspace-visible agent, including ones sitting '
      + 'in no channel, plus private agents they own; '
      + 'everybody else sees the agents working in channels they can see.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Optional name or role fragment to narrow the list, e.g. "hardware". '
            + 'Omit to see every agent you can reach.',
        },
      },
    },
    safe: true,
  },
  {
    id: 'agent_create',
    summary: 'Create a shared agent with instructions and a tool policy.',
    label: 'Create Agent',
    personalAssistantOnly: true,
    description:
      'Create a new workspace-visible or private agent — a colleague with its own instructions, model, '
      + 'and tool policy — the same record the Agent Designer writes. The agent '
      + 'gets an owner-only home conversation when private; a workspace agent starts '
      + 'in no channel and an owner puts it to work with agent_bind_channel. '
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
        visibility: {
          type: 'string',
          enum: ['workspace', 'private'],
          description:
            'Who can find this agent. workspace is the default; private means only its creator.',
        },
        ownerUserId: {
          type: 'string',
          description:
            'Optional requested owner id. A private agent can only belong to the acting user.',
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
    summary: 'Bind an existing agent to a channel.',
    label: 'Bind Agent To Channel',
    personalAssistantOnly: true,
    description:
      'Put an agent to work in a channel, so it reads and answers there. '
      + 'Organisation owners only, and only in a channel the owner is a member '
      + 'of; a Personal Assistant DM cannot take another agent. Use channel_find '
      + 'for the channelId, and agent_list for the agentId of an agent the user '
      + 'named (agent_create returns the id of one you just made).',
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
    id: 'pa_join_channel',
    summary: 'Add the requesting user’s Personal Assistant to a shared channel.',
    label: 'Add Personal Assistant To Channel',
    personalAssistantOnly: true,
    description:
      'Make your Personal Assistant available in a shared channel you already belong to. '
      + 'This adds only your own PA presence; it cannot add another member’s assistant. '
      + 'Use channel_find first when you only know the channel name.',
    parameters: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'The channel where your assistant should be present.' },
      },
      required: ['channelId'],
    },
    safe: false,
  },
  {
    id: 'agent_trigger_create',
    summary: 'Create a trigger for an existing bound agent.',
    label: 'Create Agent Trigger',
    personalAssistantOnly: true,
    description:
      'Give ANOTHER agent a trigger: a schedule, an interval, an inbound webhook, '
      + 'an event subscription, or a manual button. Organisation owners only, and '
      + 'the agent must already be bound to the target channel. Get the agentId '
      + 'from agent_list when the user named the agent. To schedule '
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
