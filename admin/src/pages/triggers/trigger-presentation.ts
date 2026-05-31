import type {
  AgentRecord,
  AgentTriggerRecord,
  ChannelRecord,
  WorkflowInstallationRecord,
  WorkflowTemplateRecord,
} from '../../lib/api-client'

export const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

export type TriggerRegistryMaps = {
  agentsById: Map<string, AgentRecord>
  channelsById: Map<string, ChannelRecord>
  workflowInstallationsById: Map<string, WorkflowInstallationRecord>
  workflowTemplatesById: Map<string, WorkflowTemplateRecord>
}

export const parseTriggerHash = (hash: string): string | undefined => {
  const match = hash.match(/^#trigger-(.+)$/)
  const encodedTriggerId = match?.[1]
  return encodedTriggerId ? decodeURIComponent(encodedTriggerId) : undefined
}

export const formatTimestamp = (value?: string) =>
  value ? new Date(value).toLocaleString() : '—'

export const getTriggerTone = (status: AgentTriggerRecord['status']) => {
  switch (status) {
    case 'active':
      return 'success' as const
    case 'paused':
      return 'warning' as const
    case 'error':
      return 'danger' as const
    default:
      return 'muted' as const
  }
}

export const getTriggerTypeLabel = (trigger: AgentTriggerRecord): string => {
  if (trigger.type === 'manual') return 'Manual start'
  if (trigger.type === 'interval') return 'Repeating interval'
  if (trigger.type === 'webhook') return 'Webhook'
  if (trigger.type === 'event') return 'System event'

  const cronExpression =
    typeof trigger.config?.cron === 'string' && trigger.config.cron.trim().length > 0
      ? trigger.config.cron
      : undefined

  return cronExpression ? 'Cron schedule' : 'One-off schedule'
}

const getWorkflowInstallationLabel = (
  installation: WorkflowInstallationRecord,
  templatesById: Map<string, WorkflowTemplateRecord>,
): string => {
  const template = templatesById.get(installation.workflowTemplateId)
  if (template) {
    return `${template.name} · ${installation.id.slice(0, 8)}`
  }

  return `Workflow ${installation.id.slice(0, 8)}`
}

export const formatTriggerTarget = (
  trigger: Pick<
    AgentTriggerRecord,
    'agentId' | 'targetChannelId' | 'workflowInstallationId'
  >,
  input: TriggerRegistryMaps,
): string => {
  if (trigger.agentId) {
    const agent = input.agentsById.get(trigger.agentId)
    const channel = trigger.targetChannelId
      ? input.channelsById.get(trigger.targetChannelId)
      : undefined
    if (agent && channel) {
      return `${agent.name} in #${channel.label}`
    }
    if (agent) {
      return agent.name
    }
    return `agent ${trigger.agentId.slice(0, 8)}`
  }

  if (trigger.workflowInstallationId) {
    const installation = input.workflowInstallationsById.get(trigger.workflowInstallationId)
    if (installation) {
      return getWorkflowInstallationLabel(installation, input.workflowTemplatesById)
    }
    return `workflow ${trigger.workflowInstallationId.slice(0, 8)}`
  }

  return 'unassigned'
}

export const getTriggerConfigRows = (
  trigger: AgentTriggerRecord,
): Array<[string, string]> => {
  if (trigger.type === 'scheduled') {
    const cronExpression =
      typeof trigger.config?.cron === 'string' && trigger.config.cron.trim().length > 0
        ? trigger.config.cron
        : undefined
    const timezone =
      typeof trigger.config?.timezone === 'string' && trigger.config.timezone.trim().length > 0
        ? trigger.config.timezone
        : undefined

    if (cronExpression) {
      return [
        ['Schedule', cronExpression],
        ['Timezone', timezone ?? 'Default'],
      ]
    }

    return [['Run at', formatTimestamp(trigger.nextRunAt)]]
  }

  if (trigger.type === 'interval') {
    const intervalMinutes =
      typeof trigger.config?.interval_minutes === 'number'
        ? `${trigger.config.interval_minutes} minutes`
        : 'Not set'
    return [
      ['Every', intervalMinutes],
      ['First run', formatTimestamp(trigger.nextRunAt)],
    ]
  }

  if (trigger.type === 'webhook') {
    return [
      ['Endpoint', '/api/triggers/webhook'],
      ['API key', trigger.webhookApiKey ?? 'Not generated yet'],
    ]
  }

  if (trigger.type === 'event') {
    const events = Array.isArray(trigger.config?.events)
      ? trigger.config.events.filter(
          (value): value is string => typeof value === 'string' && value.trim().length > 0,
        )
      : []

    return [['Events', events.length > 0 ? events.join(', ') : 'Not configured']]
  }

  return [['Mode', 'Run when manually started']]
}
