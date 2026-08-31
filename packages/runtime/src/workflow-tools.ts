import type { BuiltinToolDefinition } from './builtin-tools-types.js'

export const buildWorkflowToolDefinitions = (
  webSearchToolDefinition: BuiltinToolDefinition,
  webFetchToolDefinition: BuiltinToolDefinition,
): BuiltinToolDefinition[] => [
  webSearchToolDefinition,
  webFetchToolDefinition,
  {
    id: 'state_get',
    summary: 'Read a workflow installation checkpoint value.',
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
    summary: 'Store a workflow installation checkpoint value.',
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
        expectedVersion: {
          type: 'number',
          description:
            'Compare-and-set: the version returned by state_get/change_detect. The write fails when the stored version has moved on.',
        },
      },
      required: ['key', 'value'],
    },
    safe: true,
  },
  {
    id: 'message_send',
    summary: 'Post a deterministic workflow message to a channel.',
    label: 'Message Send',
    description:
      'Post a deterministic message to a channel — no agent run involved. Defaults to the workflow installation channel.',
    parameters: {
      type: 'object',
      properties: {
        body: {
          type: 'string',
          description: 'The message body to post (may contain {{…}} bindings)',
        },
        channelId: {
          type: 'string',
          description: 'Optional target channel; defaults to the installation channel',
        },
        threadId: {
          type: 'string',
          description: 'Optional target thread inside the channel',
        },
      },
      required: ['body'],
    },
    safe: true,
  },
  {
    id: 'change_detect',
    summary: 'Compare a value with its saved workflow checkpoint.',
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
