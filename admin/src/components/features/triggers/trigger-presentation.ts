import {
  faBolt,
  faClock,
  faHandPointer,
  faRotate,
  faTowerBroadcast,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'
import type {
  AgentRecord,
  AgentTriggerRecord,
  ChannelRecord,
  WorkflowInstallationRecord,
  WorkflowTemplateRecord,
} from '../../../lib/api-client'

/**
 * Single source for trigger display logic: labels, tones, icons, schedule
 * summaries and target formatting. Used by the Triggers page, the trigger
 * editor and the per-agent trigger panel.
 */

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

export const formatRelativeTime = (value?: string): string | undefined => {
  if (!value) return undefined

  const target = new Date(value).getTime()
  if (Number.isNaN(target)) return undefined

  const deltaMs = target - Date.now()
  const absMinutes = Math.round(Math.abs(deltaMs) / 60_000)
  const suffix = deltaMs >= 0 ? 'in ' : ''
  const prefix = deltaMs >= 0 ? '' : ' ago'

  if (absMinutes < 1) return deltaMs >= 0 ? 'in <1 min' : 'just now'
  if (absMinutes < 60) return `${suffix}${absMinutes} min${prefix}`

  const absHours = Math.round(absMinutes / 60)
  if (absHours < 48) return `${suffix}${absHours} h${prefix}`

  const absDays = Math.round(absHours / 24)
  return `${suffix}${absDays} d${prefix}`
}

export const getTriggerTone = (status: AgentTriggerRecord['status']) => {
  switch (status) {
    case 'active':
      return 'success' as const
    case 'paused':
      return 'warning' as const
    case 'error':
      return 'danger' as const
    case 'needs_reauthorization':
      return 'warning' as const
    default:
      return 'muted' as const
  }
}

/**
 * Status as a colour token for the compact list dot — colour carries the
 * state in dense rows; the full pill is reserved for the detail header.
 */
export const getTriggerStatusColor = (status: AgentTriggerRecord['status']): string => {
  switch (status) {
    case 'active':
      return 'var(--success-text)'
    case 'paused':
      return 'var(--warning-text)'
    case 'error':
      return 'var(--danger-text)'
    default:
      return 'var(--tx3)'
  }
}

export const TRIGGER_TYPE_ICONS: Record<AgentTriggerRecord['type'], IconDefinition> = {
  event: faTowerBroadcast,
  interval: faRotate,
  manual: faHandPointer,
  scheduled: faClock,
  webhook: faBolt,
}

const getCronExpression = (config: Record<string, unknown>): string | undefined =>
  typeof config.cron === 'string' && config.cron.trim().length > 0
    ? config.cron
    : undefined

export const getTriggerTypeLabel = (trigger: AgentTriggerRecord): string => {
  if (trigger.type === 'manual') return 'Manual start'
  if (trigger.type === 'interval') return 'Repeating interval'
  if (trigger.type === 'webhook') return 'Webhook'
  if (trigger.type === 'event') return 'System event'

  return getCronExpression(trigger.config ?? {}) ? 'Cron schedule' : 'One-off schedule'
}

/**
 * Compact single-line description of when the trigger fires, for list rows.
 */
export const getScheduleSummary = (trigger: AgentTriggerRecord): string => {
  const config = trigger.config ?? {}

  if (trigger.type === 'manual') return 'Fires only when started manually'
  if (trigger.type === 'webhook') return 'Fires on incoming webhook calls'

  if (trigger.type === 'event') {
    const events = Array.isArray(config.events)
      ? config.events.filter(
          (value): value is string => typeof value === 'string' && value.trim().length > 0,
        )
      : []
    return events.length > 0 ? `On ${events.join(', ')}` : 'No events configured'
  }

  if (trigger.type === 'interval') {
    const minutes =
      typeof config.interval_minutes === 'number' ? config.interval_minutes : undefined
    return minutes ? `Every ${minutes} min` : 'Interval not set'
  }

  const cron = getCronExpression(config)
  if (cron) {
    const timezone = typeof config.timezone === 'string' ? config.timezone : undefined
    return timezone ? `Cron ${cron} (${timezone})` : `Cron ${cron}`
  }

  const relative = formatRelativeTime(trigger.nextRunAt)
  return trigger.nextRunAt ? `Once ${relative ?? formatTimestamp(trigger.nextRunAt)}` : 'One-off (no run scheduled)'
}

export const getWorkflowInstallationLabel = (
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

/** Event names configured on an event trigger (empty for other types). */
export const getTriggerEventNames = (trigger: AgentTriggerRecord): string[] =>
  trigger.type === 'event' && Array.isArray(trigger.config?.events)
    ? trigger.config.events.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      )
    : []

/**
 * What a person should read when a schedule has stopped, and what they can do.
 *
 * The reason is a stable server code rather than a sentence, so the copy lives
 * here next to the rest of the trigger presentation. Before this the Triggers
 * page could show that a schedule was in ERROR but never why — the cause was
 * buried in the newest delivery row, which is how one production sweep stayed
 * broken and unexplained for nineteen days.
 */
export const TRIGGER_HEALTH_COPY: Record<string, string> = {
  uoa_identity_unverifiable:
    'This schedule can no longer prove the UnlikeOtherAI identity it was created '
    + 'with, so it has stopped running. Reauthorize it to resume.',
  member_inactive:
    'The person this schedule runs as is no longer an active member of this '
    + 'organization, so it has stopped running.',
  team_unreachable:
    'The team this schedule runs in is no longer reachable for that person, so '
    + 'it has stopped running.',
  channel_access_lost:
    'The person this schedule runs as can no longer reach its target channel, so '
    + 'it has stopped running.',
  launch_origin_invalid:
    'This schedule\'s saved launch identity is missing or inconsistent, so it '
    + 'has stopped running.',
}

export const getTriggerHealthMessage = (
  trigger: Pick<AgentTriggerRecord, 'healthDetail' | 'healthReason'>,
): string | null => {
  if (!trigger.healthReason) return null
  return (
    TRIGGER_HEALTH_COPY[trigger.healthReason]
    ?? trigger.healthDetail
    ?? 'This schedule has stopped running.'
  )
}
