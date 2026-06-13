import type { BuiltinToolDefinition } from './builtin-tools-types.js'

export const buildWorkflowToolDefinitions = (
  webSearchToolDefinition: BuiltinToolDefinition,
  webFetchToolDefinition: BuiltinToolDefinition,
): BuiltinToolDefinition[] => [
  webSearchToolDefinition,
  webFetchToolDefinition,
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
