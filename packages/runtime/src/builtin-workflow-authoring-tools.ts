import type { BuiltinToolDefinition } from './builtin-tools-types.js'

const WorkflowGraphParameter = {
  type: 'object',
  description: 'Executable workflow graph. Each step has id, type, optional title, input, and when.',
  properties: {
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          title: { type: 'string' },
          input: { type: 'object' },
          when: { type: 'string' },
        },
        required: ['id', 'type'],
      },
    },
  },
  required: ['steps'],
} as const

export const WORKFLOW_AUTHORING_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: 'workflow_list',
    category: 'workflows',
    summary: 'List workflows available to administer.',
    label: 'List Workflows',
    description:
      'List workflow names and IDs in this organization. Use it before workflow_install or workflow_preview when you do not already have an ID.',
    parameters: {
      type: 'object',
      properties: {
        cursor: { type: 'string' },
        direction: { type: 'string', enum: ['forward', 'backward'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
    safe: true,
  },
  {
    id: 'workflow_create',
    category: 'workflows',
    summary: 'Create a validated workflow template.',
    label: 'Create Workflow',
    description:
      'Create a workflow from executable steps. The graph is checked with the same validator as Admin. '
      + 'Use workflow_install next, then workflow_trigger_create to choose how it starts.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        graph: WorkflowGraphParameter,
        bindingSchema: { type: 'object' },
        variableSchema: { type: 'object' },
        requiredEnvironmentTemplateIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'graph'],
    },
    safe: false,
  },
  {
    id: 'workflow_install',
    category: 'workflows',
    summary: 'Install a workflow template so it can run.',
    label: 'Install Workflow',
    description:
      'Create an installation pinned to the current template version. Use this before adding a trigger. '
      + 'Bindings must use existing secret references, never plaintext credentials.',
    parameters: {
      type: 'object',
      properties: {
        workflowTemplateId: { type: 'string' },
        channelId: { type: 'string' },
        status: { type: 'string', enum: ['active', 'draft', 'paused', 'disabled'] },
        active: { type: 'boolean' },
        config: { type: 'object' },
        resolvedBindings: { type: 'object' },
        concurrency: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1 },
            onOverlap: { type: 'string', enum: ['skip', 'queue', 'parallel'] },
          },
        },
      },
      required: ['workflowTemplateId'],
    },
    safe: false,
  },
  {
    id: 'workflow_trigger_create',
    category: 'scheduling',
    summary: 'Choose how an installed workflow starts.',
    label: 'Create Workflow Trigger',
    description:
      'Add exactly one workflow trigger: manual, one-off or cron scheduled, fixed interval, webhook, or event. '
      + 'For scheduled triggers use config { mode:"once", at } or { cron, timezone }; for intervals use { interval_minutes, until? }.',
    parameters: {
      type: 'object',
      properties: {
        workflowInstallationId: { type: 'string' },
        type: { type: 'string', enum: ['manual', 'scheduled', 'interval', 'webhook', 'event'] },
        name: { type: 'string' },
        description: { type: 'string' },
        enabled: { type: 'boolean' },
        nextRunAt: { type: 'string' },
        config: { type: 'object' },
      },
      required: ['workflowInstallationId', 'type'],
    },
    safe: false,
  },
  {
    id: 'workflow_preview',
    category: 'workflows',
    summary: 'Post a live workflow diagram to this conversation.',
    label: 'Share Workflow Preview',
    description:
      'Post a compact live workflow preview in this chat. Tapping it opens the full diagram, '
      + 'and the card includes an Admin link to edit the workflow.',
    parameters: {
      type: 'object',
      properties: {
        workflowTemplateId: { type: 'string' },
      },
      required: ['workflowTemplateId'],
    },
    safe: false,
  },
]
