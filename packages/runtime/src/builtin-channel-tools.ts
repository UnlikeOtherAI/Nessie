import type { BuiltinToolDefinition } from './builtin-tools-types.js'

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
      'channel id, label, project/team scope, scoped slug, visibility, topic, and whether it is archived.',
    parameters: {
      type: 'object',
      properties: {
        includeArchived: {
          type: 'boolean',
          description: 'Include archived channels in the result (default false).',
        },
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
    summary: "Update a channel's label, topic, or description.",
    label: 'Update Channel',
    personalAssistantOnly: true,
    description:
      'Update a channel label, topic, and/or description. Requires the acting ' +
      'principal to be able to manage the channel (channel owner/admin, or an ' +
      'org/team owner/admin).',
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
      'Join a public channel in the current organization. Private and ' +
      'protected channels require an explicit invite and cannot be joined.',
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
    description:
      'Create a new channel in the current organization, owned by the user. '
      + 'The channel lands in the current team unless teamId says otherwise, and '
      + 'the name must be unique within its project. Any member can do this.',
    parameters: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'The channel name, e.g. "Release planning".',
        },
        visibility: {
          type: 'string',
          enum: ['public', 'protected', 'private'],
          description:
            'public (default): any member can find and join. protected/private: invite only.',
        },
        teamId: {
          type: 'string',
          description:
            'Team to create the channel in. Defaults to the team of this conversation.',
        },
      },
      required: ['label'],
    },
    safe: false,
  },
]
