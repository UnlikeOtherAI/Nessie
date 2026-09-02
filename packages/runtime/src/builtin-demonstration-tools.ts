import type { BuiltinToolDefinition } from './builtin-tools-types.js'

export const DEMONSTRATION_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: 'demonstration_start',
    category: 'workflows',
    summary: 'Start recording this agent\'s structural actions in the current conversation.',
    label: 'Start Demonstration Recording',
    description:
      'Explicitly starts an opt-in demonstration for the current agent and thread. '
      + 'It records only completed tool calls with redacted structured arguments; it never records the screen, audio, keystrokes, or tool outputs.',
    parameters: { type: 'object', properties: {} },
    safe: false,
  },
  {
    id: 'demonstration_stop',
    category: 'workflows',
    summary: 'Stop the current demonstration recording and keep its draft trace for review.',
    label: 'Stop Demonstration Recording',
    description:
      'Stops the demonstration the current person armed for this agent and thread. '
      + 'The resulting structural trace remains review-only and cannot run anything.',
    parameters: { type: 'object', properties: {} },
    safe: false,
  },
]
