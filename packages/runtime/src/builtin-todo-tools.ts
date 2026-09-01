import type { BuiltinToolDefinition } from './builtin-tools-types.js'

export const TODO_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: 'todo_template_propose',
    summary: 'Propose a reusable to-do template for owner review.',
    label: 'Propose To-do Template',
    description:
      'Creates an agent-authored draft checklist and asks an organization owner to review it. '
      + 'Use only when the current conversation did not draw on restricted material.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short reusable checklist name.' },
        description: { type: 'string', description: 'Optional description.' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short step title.' },
              instructions: { type: 'string', description: 'Exact instructions.' },
            },
            required: ['title', 'instructions'],
          },
        },
      },
      required: ['name', 'steps'],
    },
    safe: false,
  },
  {
    id: 'todo_start',
    summary: 'Start one of this agent\'s to-do checklists.',
    label: 'Start To-do',
    description:
      'Start an active checklist template, adopt one open to-do, or create and start '
      + 'one standalone checklist. Returns the current ordered checklist exactly as stored.',
    parameters: {
      type: 'object',
      properties: {
        templateId: {
          type: 'string',
          description: 'Active to-do template id to instantiate and start.',
        },
        todoId: {
          type: 'string',
          description: 'Open to-do instance id to adopt and start.',
        },
        title: {
          type: 'string',
          description: 'Standalone to-do title; use together with steps.',
        },
        steps: {
          type: 'array',
          description: 'Standalone to-do steps; use together with title.',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Optional stable step key.' },
              title: { type: 'string', description: 'Short step title.' },
              instructions: { type: 'string', description: 'Exact step instructions.' },
            },
            required: ['title', 'instructions'],
          },
        },
      },
    },
    safe: false,
  },
  {
    id: 'todo_step_update',
    summary: 'Record progress on the active to-do checklist.',
    label: 'Update To-do Step',
    description:
      'Update one step on the to-do this run currently owns. Returns the current full '
      + 'checklist so it stays fresh if a person changes another step.',
    parameters: {
      type: 'object',
      properties: {
        todoId: { type: 'string', description: 'The active to-do instance id.' },
        stepKey: { type: 'string', description: 'Stable key of the step to update.' },
        status: {
          type: 'string',
          enum: ['pending', 'running', 'completed', 'failed', 'skipped'],
          description: 'New structural status for the step.',
        },
        note: { type: 'string', description: 'Optional outcome note for the step.' },
      },
      required: ['todoId', 'stepKey', 'status'],
    },
    safe: false,
  },
]
