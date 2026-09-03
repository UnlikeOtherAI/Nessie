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
 *
 * **Two sets, split by `identityDelegatedOnly`.** The Personal Assistant keeps
 * the operational verbs on agents that already exist — `agent_list`,
 * `agent_bind_channel`, `agent_trigger_create`. Designing an agent — creating
 * one, reading its configuration in order to change it, knowing this
 * team's tool catalogue, rewriting it, restyling it — belongs to the Agent
 * Designer, which reaches these through its blueprint's `identityToolIds`; the
 * PA hands the conversation over with `agent_handoff` instead. That is the
 * whole isolation story: the design catalogue is large and belongs in one
 * agent's context, and a person who asked their assistant for an agent lands in
 * a conversation with the specialist rather than getting a thinner version of
 * it. `agent_update` gates on the agent's ownership state through the one
 * shared `canEditAgent` predicate the PUT route uses, so a conversation and a
 * form cannot disagree about who may rewrite an agent.
 */
export const AGENT_ADMIN_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: 'agent_list',
    category: 'agents',
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
      + 'one. Owners see every team-visible agent, including ones sitting '
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
    category: 'agents',
    summary: 'Create a shared agent with instructions and a tool policy.',
    label: 'Create Agent',
    personalAssistantOnly: true,
    identityDelegatedOnly: true,
    description:
      'Create a new team-visible or private agent — a colleague with its own instructions, model, '
      + 'and tool policy — the same record the Agent Designer writes. The agent '
      + 'gets an owner-only home conversation when private; a team agent starts '
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
          enum: ['team', 'private'],
          description:
            'Who can find this agent. team is the default; private means only its creator.',
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
    id: 'agent_read',
    category: 'agents',
    summary: 'Read one agent’s full configuration.',
    label: 'Read Agent',
    personalAssistantOnly: true,
    identityDelegatedOnly: true,
    description:
      'Read everything an agent is configured with — its instructions, model, '
      + 'effort, run limits, tool policy, ownership and visibility — before you '
      + 'change any of it. Use agent_list to turn a name into an agentId first. '
      + 'You only see agents you could see in the Agents list; an agent you '
      + 'cannot reach reads as missing. A Nessie-managed agent (a Personal '
      + 'Assistant, or a built-in one like this Designer) answers with its '
      + 'configuration only — no activity, messages or other people’s channels.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The agent to read.' },
      },
      required: ['agentId'],
    },
    safe: true,
  },
  {
    id: 'agent_update',
    category: 'agents',
    summary: 'Rewrite an existing agent’s configuration.',
    label: 'Update Agent',
    personalAssistantOnly: true,
    identityDelegatedOnly: true,
    description:
      'Change an existing agent: its name, role, instructions, model, effort, '
      + 'run limits, or tool policy. Read it with agent_read first and send only '
      + 'the fields that change — everything you omit is left exactly as it is, '
      + 'and toolPolicy is merged rather than replaced. Who may edit follows the '
      + 'agent: a private or person-owned agent is its owner’s (plus '
      + 'organisation owners); a team-owned one is editable by anyone who can '
      + 'reach it. Visibility cannot be changed after creation, explicit-grant '
      + 'tools (research, DeepWater, browser, mailbox) are refused here and '
      + 'granted from the owner surfaces, and Nessie-managed agents cannot be '
      + 'edited at all. When a change is refused, say who can make it.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The agent to change.' },
        name: { type: 'string', description: 'New display name.' },
        role: { type: 'string', description: 'New short role label.' },
        systemPrompt: {
          type: 'string',
          description: 'Replacement standing instructions, in full.',
        },
        model: {
          type: 'string',
          description: 'Model id from the catalogue. Send together with provider.',
        },
        provider: {
          type: 'string',
          description: 'Provider/service id. Send together with model.',
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh'],
          description: 'Reasoning effort. Carries no spend meaning.',
        },
        runLimits: {
          type: 'object',
          description:
            'Explicit per-run caps (tokens, tool calls, iterations, wall clock, cost). '
            + 'Send null to fall back to the deployment backstop.',
        },
        toolPolicy: {
          type: 'object',
          description:
            'Per-tool allow/deny map merged into the current policy, e.g. '
            + '{"web_search": true, "http_fetch": false}. Use agent_tool_catalog '
            + 'for the keys. Explicit-grant tools are rejected.',
        },
        todosEnabled: {
          type: 'boolean',
          description:
            'Turn the agent’s to-do capability on or off. Organisation owners '
            + 'only — say who can do it when refused.',
        },
        ownerUserId: {
          type: 'string',
          description:
            'Hand the agent to a different person, or send null to make it '
            + 'team-owned. Only its current owner or an organisation owner may; '
            + 'private agents cannot be transferred at all.',
        },
      },
      required: ['agentId'],
    },
    safe: false,
  },
  {
    id: 'agent_tool_catalog',
    category: 'agents',
    summary: 'List the tools an agent can be given, with their policy keys.',
    label: 'Agent Tool Catalogue',
    personalAssistantOnly: true,
    identityDelegatedOnly: true,
    description:
      'The live list of tools a designed agent can be given in this team: '
      + 'the built-in tools and the organisation’s connected apps, each with the '
      + 'exact key to write in a toolPolicy and whether it is on or off by '
      + 'default. Call it before proposing or changing a tool policy so you name '
      + 'tools that actually exist here rather than ones you remember. It also '
      + 'names the tools nobody can grant from a conversation, and why.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Optional fragment to narrow the list by tool name or key, e.g. "mail".',
        },
      },
    },
    safe: true,
  },
  {
    id: 'agent_avatar_update',
    category: 'agents',
    summary: 'Set or clear an agent’s portrait.',
    label: 'Update Agent Avatar',
    personalAssistantOnly: true,
    identityDelegatedOnly: true,
    description:
      'Attach an already-stored image as an agent’s portrait, or clear the one '
      + 'it has. Follows the same edit authority as agent_update. Newly created '
      + 'agents already get a generated portrait, so this is for replacing one '
      + 'with an image the person supplied.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The agent whose portrait changes.' },
        avatarAttachmentId: {
          type: 'string',
          description:
            'Attachment id of the image to use. Send null to clear the portrait.',
        },
        avatarBackgroundColor: {
          type: 'string',
          description: 'Optional tile colour behind the portrait, as a hex value.',
        },
      },
      required: ['agentId'],
    },
    safe: false,
  },
  {
    id: 'agent_bind_channel',
    category: 'agents',
    summary: 'Bind an existing agent to a channel.',
    label: 'Bind Agent To Channel',
    personalAssistantOnly: true,
    description:
      'Put an agent to work in a channel, so it reads and answers there. '
      + 'Organisation owners only, and only in a channel the owner is a member '
      + 'of; a Personal Assistant DM cannot take another agent. Use channel_find '
      + 'for the channelId, and agent_list for the agentId of an agent the user '
      + 'named.',
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
    category: 'channels',
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
    category: 'scheduling',
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
