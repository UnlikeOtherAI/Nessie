import {
  FILE_GLOB_TOOL_DEFINITION,
  FILE_READ_TOOL_DEFINITION,
  FILE_WRITE_TOOL_DEFINITION,
  HTTP_FETCH_TOOL_DEFINITION,
} from './builtin-tools-sandboxed.js'
import type { BuiltinToolDefinition } from './builtin-tools-types.js'

export type { BuiltinToolDefinition } from './builtin-tools-types.js'
export {
  FILE_GLOB_TOOL_DEFINITION,
  FILE_READ_TOOL_DEFINITION,
  FILE_WRITE_TOOL_DEFINITION,
  HTTP_FETCH_TOOL_DEFINITION,
  SANDBOXED_BUILTIN_TOOL_DEFINITIONS,
} from './builtin-tools-sandboxed.js'

const WEB_SEARCH_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'web_search',
  label: 'Web Search',
  description: 'Search the public web. Returns top 3 results with titles and URLs.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
    },
    required: ['query'],
  },
  safe: true,
}

const WEB_FETCH_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'web_fetch',
  label: 'Web Fetch',
  description: 'Fetch and read a public URL. Returns the text content.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch',
      },
    },
    required: ['url'],
  },
  safe: true,
}

export const BUILTIN_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: 'workspace_search',
    label: 'Workspace Search',
    description:
      'Search visible workspace channels, threads, and messages for the current user. Returns compact results with IDs and snippets.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The workspace search query',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of results to return',
        },
      },
      required: ['query'],
    },
    safe: true,
  },
  {
    id: 'authored_message_search',
    label: 'Authored Message Search',
    description:
      'Search messages authored by the current user across visible workspace channels and threads.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The text to search for in authored messages',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of results to return',
        },
      },
      required: ['query'],
    },
    safe: true,
  },
  {
    id: 'people_search',
    label: 'People Search',
    description:
      'Search people in the current organization by display name or email address.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The name or email search query',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of results to return',
        },
      },
      required: ['query'],
    },
    safe: true,
  },
  {
    id: 'send_message',
    label: 'Send Message',
    description:
      'Send a message as the current user to a thread, channel, or a DM by targetUserId.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Message content to send',
        },
        threadId: {
          type: 'string',
          description: 'Destination thread ID',
        },
        channelId: {
          type: 'string',
          description: 'Destination channel ID',
        },
        targetUserId: {
          type: 'string',
          description: 'User ID to DM',
        },
      },
      required: ['content'],
    },
    safe: false,
  },
  {
    id: 'update_preferences',
    label: 'Update Preferences',
    description:
      'Update the current user preferences object, such as starred channels or people.',
    parameters: {
      type: 'object',
      properties: {
        preferences: {
          type: 'object',
          description: 'The replacement user preferences object',
        },
      },
      required: ['preferences'],
    },
    safe: false,
  },
  {
    id: 'web_fetch',
    label: 'Web Fetch',
    description: 'Fetch and read a public URL. Returns the text content.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch',
        },
      },
      required: ['url'],
    },
    safe: true,
  },
  {
    id: 'document_read',
    label: 'Document Read',
    description: 'Read a project-local document by path or topic. Returns markdown content.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Document path or topic to search for',
        },
      },
      required: ['query'],
    },
    safe: true,
  },
  {
    id: 'spawn_subtask',
    label: 'Spawn Sub-Task',
    description:
      'Delegate a specific sub-task to a new child agent. Use when a task is complex enough to benefit from parallel or specialized work. The child agent will complete the task and report back.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Clear description of the sub-task to delegate',
        },
        role: {
          type: 'string',
          description:
            'Role for the child agent: researcher, builder, reviewer',
        },
      },
      required: ['task'],
    },
    safe: true,
  },
  WEB_SEARCH_TOOL_DEFINITION,
  WEB_FETCH_TOOL_DEFINITION,
  HTTP_FETCH_TOOL_DEFINITION,
  FILE_READ_TOOL_DEFINITION,
  FILE_WRITE_TOOL_DEFINITION,
  FILE_GLOB_TOOL_DEFINITION,
]

export const WORKFLOW_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  WEB_SEARCH_TOOL_DEFINITION,
  WEB_FETCH_TOOL_DEFINITION,
  {
    id: 'state_get',
    label: 'State Get',
    description:
      'Load the current value for a workflow checkpoint key stored for the workflow installation.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The checkpoint key to load',
        },
        defaultValue: {
          description: 'Optional fallback value when no state exists yet',
        },
      },
      required: ['key'],
    },
    safe: true,
  },
  {
    id: 'state_put',
    label: 'State Put',
    description:
      'Persist a value for a workflow checkpoint key stored for the workflow installation.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The checkpoint key to store',
        },
        value: {
          description: 'The value to store for the checkpoint',
        },
      },
      required: ['key', 'value'],
    },
    safe: true,
  },
  {
    id: 'change_detect',
    label: 'Change Detect',
    description:
      'Compare a current value with the stored checkpoint and report whether it changed.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The checkpoint key to compare against',
        },
        value: {
          description: 'The current value to compare',
        },
      },
      required: ['key', 'value'],
    },
    safe: true,
  },
]

export const BUILTIN_TOOL_IDS = new Set(BUILTIN_TOOL_DEFINITIONS.map((tool) => tool.id))

export const WORKFLOW_TOOL_IDS = new Set(
  WORKFLOW_TOOL_DEFINITIONS.map((tool) => tool.id),
)

export const SYSTEM_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  ...BUILTIN_TOOL_DEFINITIONS,
  ...WORKFLOW_TOOL_DEFINITIONS.filter((tool) => !BUILTIN_TOOL_IDS.has(tool.id)),
]

export const SYSTEM_TOOL_IDS = new Set(
  SYSTEM_TOOL_DEFINITIONS.map((tool) => tool.id),
)
