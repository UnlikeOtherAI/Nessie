import type { BuiltinToolDefinition } from './builtin-tools-types.js'

export const SCHEDULE_TASK_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'schedule_task',
  summary: 'Schedule this agent to run a task once or repeatedly.',
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
          'Optional channel ID or scoped slug (project/channel) to post results into. ' +
          'Omit to use the current conversation. Use channel_find first when you only know a name.',
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

export const LIST_SCHEDULED_TASKS_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'list_scheduled_tasks',
  summary: 'List scheduled tasks created for the current user.',
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

export const CANCEL_SCHEDULED_TASK_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'cancel_scheduled_task',
  summary: 'Disable a scheduled task by its ID or name.',
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
