import { AGENT_ADMIN_TOOL_DEFINITIONS } from './builtin-agent-tools.js'
import { APP_SETUP_TOOL_DEFINITIONS } from './builtin-app-setup-tools.js'
import {
  DASHBOARD_EMBED_TOOL_DEFINITIONS,
  DASHBOARD_TOOL_DEFINITIONS,
} from './builtin-dashboard-tools.js'
import {
  ATTACHMENT_LIST_TOOL_DEFINITION,
  ATTACHMENT_READ_TOOL_DEFINITION,
  ATTACHMENT_UPLOAD_TOOL_DEFINITION,
} from './builtin-attachment-tools.js'
import { CARD_TOOL_DEFINITIONS } from './builtin-card-tools.js'
import { HANDOFF_TOOL_DEFINITIONS } from './builtin-handoff-tools.js'
import { CHANNEL_TOOL_DEFINITIONS } from './builtin-channel-tools.js'
import { TEAM_STRUCTURE_TOOL_DEFINITIONS } from './builtin-team-structure-tools.js'
import { BROWSER_TOOL_DEFINITIONS } from './builtin-browser-tools.js'
import { COMMS_TOOL_DEFINITIONS } from './builtin-comms-tools.js'
import { EMAIL_TOOL_DEFINITIONS } from './builtin-email-tools.js'
import { GOOGLE_TOOL_DEFINITIONS } from './builtin-google-tools.js'
import { MAILBOX_TOOL_DEFINITIONS } from './builtin-mailbox-tools.js'
import { MAIL_PRESENT_TOOL_DEFINITION } from './builtin-mail-presentation-tools.js'
import { CONNECTOR_TOOL_DEFINITIONS } from './builtin-connector-tools.js'
import { EXECUTOR_TOOL_DEFINITIONS } from './builtin-executor-tools.js'
import { INTEGRATION_TOOL_DEFINITIONS } from './builtin-integration-tools.js'
import { KB_COMMENT_TOOL_DEFINITIONS } from './builtin-kb-comment-tools.js'
import { KB_TOOL_DEFINITIONS } from './builtin-kb-tools.js'
import { TODO_TOOL_DEFINITIONS } from './builtin-todo-tools.js'
import { DEMONSTRATION_TOOL_DEFINITIONS } from './builtin-demonstration-tools.js'

export { KB_DOCUMENT_COMPOSE_TOOL_ID, KB_DOCUMENT_EDIT_TOOL_ID } from './builtin-kb-tools.js'
import {
  CANCEL_SCHEDULED_TASK_TOOL_DEFINITION,
  LIST_SCHEDULED_TASKS_TOOL_DEFINITION,
  SCHEDULE_TASK_TOOL_DEFINITION,
} from './builtin-schedule-tools.js'
import {
  FILE_GLOB_TOOL_DEFINITION,
  FILE_READ_TOOL_DEFINITION,
  FILE_WRITE_TOOL_DEFINITION,
  HTTP_FETCH_TOOL_DEFINITION,
} from './builtin-tools-sandboxed.js'
import type { BuiltinToolDefinition } from './builtin-tools-types.js'
import { buildWorkflowToolDefinitions } from './workflow-tools.js'

export { CARD_POST_TOOL_ID, CARD_POST_TOOL_DEFINITION } from './builtin-card-tools.js'
export {
  AGENT_HANDOFF_TOOL_DEFINITION,
  AGENT_HANDOFF_TOOL_ID,
} from './builtin-handoff-tools.js'
export type { BuiltinToolDefinition } from './builtin-tools-types.js'
export {
  APP_CONNECT_REQUEST_TOOL_DEFINITION,
  APP_CONNECT_REQUEST_TOOL_ID,
  APP_SEARCH_TOOL_DEFINITION,
  APP_SEARCH_TOOL_ID,
} from './builtin-app-setup-tools.js'
export { TODO_TOOL_DEFINITIONS } from './builtin-todo-tools.js'
export {
  FILE_GLOB_TOOL_DEFINITION,
  FILE_READ_TOOL_DEFINITION,
  FILE_WRITE_TOOL_DEFINITION,
  HTTP_FETCH_TOOL_DEFINITION,
  SANDBOXED_BUILTIN_TOOL_DEFINITIONS,
} from './builtin-tools-sandboxed.js'

const WEB_SEARCH_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'web_search',
  category: 'web',
  summary: 'Search the public web for current results and answer snippets.',
  label: 'Web Search',
  description:
    'Search the public web through Ledger-metered Serper results for up-to-date ' +
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
  category: 'web',
  summary: 'Extract readable text from a public web page URL.',
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

// Fan-out to a sub-agent. Advertised to ordinary agent runs so the model can
// push discovery legwork out of its own context; the worker dispatches it
// itself (nested loop, isolated MCP view, small fixed budget) rather than
// through the builtin executor, and never advertises it inside a sub-agent or
// on a DeepWater launch turn.
const DELEGATE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'delegate',
  category: 'agents',
  summary: 'Delegate focused discovery work to a sub-agent.',
  label: 'Delegate to Sub-agent',
  description:
    'Dispatch a focused sub-agent to do discovery legwork — searches, fetches, ' +
    'and external (MCP) lookups — and report back a short digest instead of raw ' +
    'results. Use one sub-agent per angle to keep bulky pages and transcripts out ' +
    'of this conversation, then work from the digests. The sub-agent sees only the ' +
    'task you write, cannot ask you questions, and cannot delegate further.',
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
}

export const BUILTIN_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: 'team_search',
    category: 'team',
    summary: 'Search accessible team conversations, threads, and messages.',
    label: 'Team Search',
    description:
      'Search past conversations (channels, threads, and messages) you have access to. Returns compact results with IDs, snippets, and a `link=` path — quote that link directly rather than describing the location in prose.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The team search query',
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
    category: 'conversation',
    summary: 'Search accessible messages written by the current user.',
    label: 'Authored Message Search',
    personalAssistantOnly: true,
    description:
      'Search messages authored by the current user across visible team channels and threads. Each result carries a `link=` path — quote that link directly rather than describing the location in prose.',
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
    category: 'team',
    summary: 'Find organization people by display name or email address.',
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
    category: 'conversation',
    summary: 'Send a message as the current user.',
    label: 'Send Message',
    personalAssistantOnly: true,
    description:
      'Send a message as the current user to a thread, channelId, or a DM by targetUserId. ' +
      'Resolve named channels with channel_find first; do not guess between duplicate channel names.',
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
    category: 'team',
    summary: "Replace the current user's team preferences.",
    label: 'Update Preferences',
    personalAssistantOnly: true,
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
    id: 'workflow_transform_preview',
    category: 'workflows',
    summary: 'Test a workflow JMESPath transform against sample JSON.',
    label: 'Workflow Transform Preview',
    description:
      'Evaluate a workflow JMESPath expression against a sample JSON document and return the result. ' +
      'Use it to author and check a `transform` step mapping (or an inline `jmespath:` value) before saving ' +
      'the graph — the same compiler and security envelope the designer and the worker use.',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'The JMESPath expression to evaluate',
        },
        sampleJson: {
          description: 'The sample document to evaluate against (JSON value or JSON string)',
        },
      },
      required: ['expression', 'sampleJson'],
    },
    safe: true,
  },
  {
    id: 'document_read',
    category: 'knowledge',
    summary: 'Read a project-local markdown document by path or topic.',
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
    category: 'agents',
    summary: 'Create a child agent for a specific subtask.',
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
  DELEGATE_TOOL_DEFINITION,
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
    category: 'conversation',
    summary: 'Search accessible channel messages, optionally within one channel.',
    label: 'Message Search',
    description:
      'Full-text search across messages in channels visible to you. Returns ' +
      'compact results with message IDs, snippets, channel, author, and a ' +
      '`link=` path — quote that link directly rather than describing the ' +
      'location in prose.',
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
    category: 'conversation',
    summary: 'Edit a message previously authored by this agent.',
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
    id: 'react',
    category: 'conversation',
    summary: "Add or remove this agent's emoji reaction to a message.",
    label: 'React To Message',
    description:
      'Add or remove an emoji reaction on a message — the same buttons a person '
      + 'clicks. Use it to acknowledge something that needs registering but no '
      + 'reply (👍 to confirm, 🎉 for good news, 👀 when you have seen it and will '
      + 'act later): a reaction says it without adding a message to read. Typing '
      + 'an emoji into a reply is not the same thing — that is still a message. '
      + 'Set remove: true to take one of your own reactions back off.',
    parameters: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'The message to react to.',
        },
        emoji: {
          type: 'string',
          description: 'A single emoji, e.g. 👍',
        },
        remove: {
          type: 'boolean',
          description: 'Remove this reaction instead of adding it.',
        },
      },
      required: ['messageId', 'emoji'],
    },
    safe: false,
  },
  {
    id: 'message_delete',
    category: 'conversation',
    summary: 'Soft-delete a message previously authored by this agent.',
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
  ...CARD_TOOL_DEFINITIONS,
  ...HANDOFF_TOOL_DEFINITIONS,
  ...CHANNEL_TOOL_DEFINITIONS,
  ...TEAM_STRUCTURE_TOOL_DEFINITIONS,
  ...AGENT_ADMIN_TOOL_DEFINITIONS,
  ...DASHBOARD_TOOL_DEFINITIONS,
  ...DASHBOARD_EMBED_TOOL_DEFINITIONS,
  ...KB_COMMENT_TOOL_DEFINITIONS,
  ...KB_TOOL_DEFINITIONS,
  ...CONNECTOR_TOOL_DEFINITIONS,
  ...EXECUTOR_TOOL_DEFINITIONS,
  ...BROWSER_TOOL_DEFINITIONS,
  ...INTEGRATION_TOOL_DEFINITIONS,
  ...COMMS_TOOL_DEFINITIONS,
  ...EMAIL_TOOL_DEFINITIONS,
  ...GOOGLE_TOOL_DEFINITIONS,
  ...MAILBOX_TOOL_DEFINITIONS,
  MAIL_PRESENT_TOOL_DEFINITION,
  ...APP_SETUP_TOOL_DEFINITIONS,
  ...TODO_TOOL_DEFINITIONS,
  ...DEMONSTRATION_TOOL_DEFINITIONS,
]

// `delegate` is deliberately absent: the workflow builtin-tool executor has no
// case for it, so save-time validation must not accept a tool that can only
// fail at runtime (workflows-first-class plan, W5).
export const WORKFLOW_TOOL_DEFINITIONS: BuiltinToolDefinition[] = buildWorkflowToolDefinitions(
  WEB_SEARCH_TOOL_DEFINITION,
  WEB_FETCH_TOOL_DEFINITION,
)

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
