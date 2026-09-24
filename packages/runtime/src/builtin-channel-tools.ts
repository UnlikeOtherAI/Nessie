import type { BuiltinToolDefinition } from './builtin-tools-types.js'
import { channelDecisionPolicyParameters } from './channel-decision-tool-schema.js'

/**
 * Channel lifecycle tools (sp-channels). Finding and listing are open to any
 * agent; creating, renaming, archiving, and joining act with the acting user's
 * own rights, so they are personal-assistant only. `channel_create` mirrors
 * `POST /api/channels`, which any authenticated member may call.
 */
export const CHANNEL_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: 'channel_find',
    category: 'channels',
    summary: 'Resolve a channel name or scoped slug to its ID.',
    label: 'Find Channel',
    description:
      'Resolve a channel by name or scoped slug (e.g. "general", "#product", or "project/general") to its id. ' +
      'Use this to get a channelId before posting or acting on a channel — ' +
      'do not ask the user for an id. Returns matching channels with id, ' +
      'label, project/team scope, scoped slug, and visibility; use scope or channelId to distinguish duplicate labels.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The channel name (or part of it) to look up.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of matches to return (default 10).',
        },
      },
      required: ['query'],
    },
    safe: true,
  },
  {
    id: 'channel_list',
    category: 'channels',
    summary: 'List visible organization channels and their details.',
    label: 'List Channels',
    description:
      'List channels visible in the current organization. Returns each ' +
      'channel id, label, project/team scope, scoped slug, visibility, topic, and whether it is archived. ' +
      'Pass channelId to read that channel\'s decision policy and its bound agent references before editing the policy.',
    parameters: {
      type: 'object',
      properties: {
        includeArchived: {
          type: 'boolean',
          description: 'Include archived channels in the result (default false).',
        },
        channelId: { type: 'string', description: 'Read the current policy and bound agent references for this channel.' },
        limit: {
          type: 'integer',
          description: 'Maximum number of channels to return.',
        },
      },
    },
    safe: true,
  },
  {
    id: 'channel_update',
    category: 'channels',
    summary: "Update a channel's details or agent decision policy.",
    label: 'Update Channel',
    personalAssistantOnly: true,
    description:
      'Update a channel label, topic, and/or description. Requires the acting ' +
      'principal to be able to change the channel: any member of it, or an ' +
      'organisation owner or admin when the channel is public. A direct message ' +
      'can only be changed by its participants. Agent decision policies apply only to standard channels. ' +
      'Read the current policy with channel_list(channelId) first. Each enum question needs at least ' +
      'two options and one option without follow-up work. Follow-ups preserve the agent\'s existing permissions.',
    parameters: {
      type: 'object',
      properties: {
        channelId: {
          type: 'string',
          description: 'The channel ID to update.',
        },
        label: {
          type: 'string',
          description: 'New channel name.',
        },
        topic: {
          type: 'string',
          description: 'New short topic for the channel.',
        },
        description: {
          type: 'string',
          description: 'New longer description for the channel.',
        },
        decisionPolicy: channelDecisionPolicyParameters,
      },
      required: ['channelId'],
    },
    safe: false,
  },
  {
    id: 'channel_archive',
    category: 'channels',
    summary: 'Archive or unarchive a channel without deleting history.',
    label: 'Archive Channel',
    personalAssistantOnly: true,
    description:
      'Archive or unarchive a channel. Archiving hides it from default ' +
      'listings without deleting its history. Requires channel-manage rights.',
    parameters: {
      type: 'object',
      properties: {
        channelId: {
          type: 'string',
          description: 'The channel ID to archive or unarchive.',
        },
        archived: {
          type: 'boolean',
          description:
            'true to archive (default), false to unarchive.',
        },
      },
      required: ['channelId'],
    },
    safe: false,
  },
  {
    id: 'channel_join',
    category: 'channels',
    summary: 'Join a public organization channel.',
    label: 'Join Channel',
    personalAssistantOnly: true,
    description:
      'Join a public channel in the current organization. Protected channels ' +
      'require an explicit invite and cannot be joined.',
    parameters: {
      type: 'object',
      properties: {
        channelId: {
          type: 'string',
          description: 'The public channel ID to join.',
        },
      },
      required: ['channelId'],
    },
    safe: false,
  },
  {
    id: 'channel_create',
    category: 'channels',
    summary: 'Create a new organization channel.',
    label: 'Create Channel',
    personalAssistantOnly: true,
    projectOperator: true,
    description:
      'Create a new channel in the current organization, acting as the person '
      + 'asking you with exactly their rights; they own it. '
      + 'Pass the projectId and teamId returned by project_list. The name must '
      + 'be unique within its project. Any member can do this. The result links '
      + 'the new room as [#label](/channels/<channelId>): the last path segment '
      + 'of that link is the channelId agent_bind_channel takes to put an agent '
      + 'in it; people are invited from the channel page.',
    parameters: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'The channel name, e.g. "Release planning".',
        },
        projectId: {
          type: 'string',
          description:
            'Project that owns the channel, from project_list — or, for a project '
            + 'just made, the last path segment of the /projects/… link project_create returned.',
        },
        visibility: {
          type: 'string',
          enum: ['public', 'protected'],
          description:
            'public: any member can find, read and join. protected: it is '
            + 'listed with a lock and outsiders see only its name and members, '
            + 'so getting in is by invitation and the person you are acting '
            + 'for is its sole member. Always set this from what the person '
            + 'actually asked for — who else should see the channel is not '
            + 'something to assume. Omitted, an agent working in a project '
            + 'channel makes it protected. A channel a ticket trigger works in '
            + 'must be public.',
        },
        teamId: {
          type: 'string',
          description: 'Team that owns the selected project, from project_list.',
        },
      },
      required: ['label', 'projectId', 'teamId'],
    },
    safe: false,
  },
]
