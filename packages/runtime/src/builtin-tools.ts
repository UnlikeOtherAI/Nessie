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
  description:
    'Search the public web (Google results via serper.dev) for up-to-date ' +
    'outside information. Returns top results with titles, URLs, and snippets, ' +
    'plus a direct answer when one is available.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      page: {
        type: 'integer',
        description:
          'Google results page to fetch (1-indexed, default 1). Use 2, 3, 4… ' +
          'to reach deeper results beyond the first page.',
        minimum: 1,
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

const SCHEDULE_TASK_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'schedule_task',
  label: 'Schedule Task',
  description:
    'Schedule yourself to run a task later — once, on a recurring cron schedule, ' +
    'or on a fixed interval. The task can be ANYTHING you are able to do with your ' +
    'tools (web search, fetching URLs, reading/writing files, sending messages, ' +
    'MCP tools, delegating to sub-agents, etc.) — describe it in plain language in ' +
    '`instructions`. When the schedule fires you run with those instructions as ' +
    'your prompt and report back in the target conversation; findings are saved to ' +
    'your long-term memory automatically. Defaults to the current conversation if ' +
    'no target is given. Examples: every weekday 9am → cron "0 9 * * 1-5"; ' +
    'hourly → cron "0 * * * *"; once at a specific time → kind "once" with an ISO ' +
    '`at`; every 30 minutes → kind "interval" with every_minutes 30.',
  parameters: {
    type: 'object',
    properties: {
      instructions: {
        type: 'string',
        description:
          'Plain-language description of the task to perform each time the ' +
          'schedule fires, including how to report the result.',
      },
      schedule: {
        type: 'object',
        description: 'When to run the task.',
        properties: {
          kind: {
            type: 'string',
            enum: ['once', 'recurring', 'interval'],
            description:
              '"once" = a single run at `at`; "recurring" = repeat on `cron`; ' +
              '"interval" = repeat every `every_minutes` minutes.',
          },
          at: {
            type: 'string',
            description:
              'Absolute ISO 8601 date-time for a one-off run (kind "once"), e.g. '
              + '"2026-06-01T09:00:00Z". Must include a UTC offset/Z and be in the '
              + 'future. Resolve relative times ("tomorrow 9am") against the current '
              + 'time given in your system context.',
          },
          cron: {
            type: 'string',
            description:
              'Standard 5-field cron expression for recurring runs (kind "recurring").',
          },
          every_minutes: {
            type: 'integer',
            description: 'Interval length in minutes (kind "interval").',
            minimum: 1,
          },
          timezone: {
            type: 'string',
            description:
              'IANA timezone (e.g. "Europe/London") applied to cron schedules. '
              + 'Defaults to UTC if omitted — set it when the user means a local '
              + 'wall-clock time, asking them if their timezone is unknown.',
          },
        },
        required: ['kind'],
      },
      target: {
        type: 'string',
        description:
          'Optional channel name or ID to post results into. Omit to use the ' +
          'current conversation.',
      },
      name: {
        type: 'string',
        description: 'Optional short label for the scheduled task.',
      },
    },
    required: ['instructions', 'schedule'],
  },
  safe: false,
}

const LIST_SCHEDULED_TASKS_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'list_scheduled_tasks',
  label: 'List Scheduled Tasks',
  description:
    'List the scheduled tasks you have created for the current user, including ' +
    'their schedule, target, next run time, and whether they are active.',
  parameters: {
    type: 'object',
    properties: {},
  },
  safe: true,
}

const CANCEL_SCHEDULED_TASK_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'cancel_scheduled_task',
  label: 'Cancel Scheduled Task',
  description:
    'Cancel (disable) a previously scheduled task by its id or name so it stops ' +
    'running.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The scheduled task id to cancel.',
      },
      name: {
        type: 'string',
        description: 'The scheduled task name to cancel (used when id is omitted).',
      },
    },
  },
  safe: false,
}

// ─── File uploads / attachments (Slack-parity files slice) ──────────────────
// Named `attachment_*` rather than `file_*` because `file_read`/`file_write`/
// `file_glob` are already sandbox-filesystem tools; these operate on uploaded
// workspace attachments stored via the blob storage adapter.
const ATTACHMENT_UPLOAD_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'attachment_upload',
  label: 'Upload Attachment',
  description:
    'Store a file as a workspace attachment. Provide the raw bytes as base64 ' +
    'in contentBase64 along with a filename and MIME type. Returns the new ' +
    'attachment id, which can be linked to a message via send_message ' +
    'attachmentIds.',
  parameters: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'File name including extension' },
      mime: { type: 'string', description: 'MIME type, e.g. "text/plain" or "image/png"' },
      contentBase64: { type: 'string', description: 'Base64-encoded file bytes' },
      channelId: {
        type: 'string',
        description: 'Optional channel context the attachment belongs to',
      },
    },
    required: ['filename', 'mime', 'contentBase64'],
  },
  safe: false,
}

const ATTACHMENT_LIST_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'attachment_list',
  label: 'List Attachments',
  description:
    'List attachments linked to messages in a thread or channel you can access. ' +
    'Returns id, filename, mime, and sizeBytes for each.',
  parameters: {
    type: 'object',
    properties: {
      threadId: { type: 'string', description: 'Thread to list attachments from' },
      channelId: { type: 'string', description: 'Channel to list attachments from' },
      limit: { type: 'integer', description: 'Maximum results (default 20)', minimum: 1 },
    },
  },
  safe: true,
}

const ATTACHMENT_READ_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'attachment_read',
  label: 'Read Attachment',
  description:
    'Return metadata for an attachment, plus the decoded text content for ' +
    'small text-like files. Binary or oversized files return metadata only.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The attachment id to read' },
    },
    required: ['id'],
  },
  safe: true,
}

export const BUILTIN_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: 'workspace_search',
    label: 'Workspace Search',
    description:
      'Search past conversations (channels, threads, and messages) you have access to. Returns compact results with IDs and snippets.',
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
  SCHEDULE_TASK_TOOL_DEFINITION,
  LIST_SCHEDULED_TASKS_TOOL_DEFINITION,
  CANCEL_SCHEDULED_TASK_TOOL_DEFINITION,
  // sp-messaging slice: full-text search + agent-authored message lifecycle
  {
    id: 'message_search',
    label: 'Message Search',
    description:
      'Full-text search across messages in channels visible to you. Returns ' +
      'compact results with message IDs, snippets, channel, and author.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The full-text search query',
        },
        channelId: {
          type: 'string',
          description: 'Optional channel ID to scope the search to',
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
    id: 'message_edit',
    label: 'Message Edit',
    description:
      'Edit a message you (this agent) previously authored. Replaces the ' +
      'content and marks the message as edited.',
    parameters: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'ID of the message to edit',
        },
        content: {
          type: 'string',
          description: 'New message content',
        },
      },
      required: ['messageId', 'content'],
    },
    safe: false,
  },
  {
    id: 'message_delete',
    label: 'Message Delete',
    description:
      'Soft-delete a message you (this agent) previously authored. The message ' +
      'becomes a tombstone and its content is removed.',
    parameters: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'ID of the message to delete',
        },
      },
      required: ['messageId'],
    },
    safe: false,
  },
  ATTACHMENT_UPLOAD_TOOL_DEFINITION,
  ATTACHMENT_LIST_TOOL_DEFINITION,
  ATTACHMENT_READ_TOOL_DEFINITION,
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
  {
    id: 'delegate',
    label: 'Delegate to External-Tools Sub-agent',
    description:
      'Hand a task to a sub-agent that has access to external (MCP) tools. The sub-agent runs a tight loop with those tools and returns a concise answer. Use this for any task that requires real outside lookups (web search, third-party APIs, file systems, etc.) — do not pretend to know things you cannot fetch yourself.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'A self-contained task description for the sub-agent. Include any relevant context — the sub-agent only sees this string, not the rest of your conversation.',
        },
        hint: {
          type: 'string',
          description:
            'Optional hint about which tool category to favor (e.g. "web search", "filesystem", "github").',
        },
      },
      required: ['task'],
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
