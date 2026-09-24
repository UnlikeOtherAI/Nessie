import type {
  AgentRecord,
  AgentTriggerRecord,
  ChannelRecord,
  WorkflowInstallationRecord,
} from '../../../lib/api-client'
import {
  buildDocumentConfig,
  documentStateFromConfig,
  getDefaultDocumentState,
  type DocumentFormField,
  type DocumentTriggerFormState,
  type DocumentTriggerPrefill,
} from './document-trigger-form'
import {
  buildTicketConfig,
  getDefaultTicketState,
  isTicketTargetChannel,
  ticketStateFromConfig,
  type TicketFormField,
  type TicketTriggerFormState,
} from './ticket-trigger-form'

export type TriggerTargetKind = 'agent' | 'workflow'
export type ScheduleMode = 'cron' | 'once'

export type TriggerFormState = {
  description: string
  enabled: boolean
  eventFilter: string
  eventNames: string
  intervalMinutes: string
  name: string
  nextRunAt: string
  /** When true, quiet recurring runs fold into one rolling status message. */
  rollingStatus: boolean
  scheduleMode: ScheduleMode
  /** Optional end of a recurring schedule; empty means "runs until paused". */
  until: string
  targetChannelId: string
  targetKind: TriggerTargetKind
  triggerType: AgentTriggerRecord['type']
  workflowInstallationId: string
  cron: string
  timezone: string
  agentId: string
  /**
   * The `ticket_changed` fields (`ticket-trigger-form.ts`). Optional because a
   * draft stored before the type existed has none; readers fall back to the
   * defaults.
   */
  ticket?: TicketTriggerFormState
  /** The `document_changed` fields (`document-trigger-form.ts`); optional for the same reason. */
  document?: DocumentTriggerFormState
}

export type SubmitPayload = {
  config?: Record<string, unknown>
  description?: string
  enabled: boolean
  name: string
  nextRunAt?: string
}

export type DefaultTarget =
  | {
      agentId: string
      targetChannelId?: string
      targetKind: 'agent'
      /**
       * A doorway that opens the editor on one type already: the board's column
       * menu opens it on a ticket trigger for that board and column, and the
       * Finder on a document trigger for that folder or page.
       */
      prefill?:
        | {
            name?: string
            ticket: { boardId: string; pickupColumnIds: string[] }
            triggerType: 'ticket_changed'
          }
        | {
            document: DocumentTriggerPrefill
            name?: string
            triggerType: 'document_changed'
          }
    }
  | {
      targetKind: 'workflow'
      workflowInstallationId: string
    }

/**
 * The channels a trigger of this type may target for this agent: every one it
 * is bound to, or for a ticket or document trigger only its live, ordinary,
 * public project ones — every reader of the ticket or document has to be able
 * to open the thread it is worked in. The server refuses anything else, and
 * the field says why.
 */
export const triggerTargetChannels = (
  channels: readonly ChannelRecord[],
  agent: Pick<AgentRecord, 'channelIds'> | undefined,
  type: AgentTriggerRecord['type'],
): ChannelRecord[] => {
  const bound = new Set(agent?.channelIds ?? [])
  const projectWork = type === 'ticket_changed' || type === 'document_changed'
  return channels.filter((channel) => bound.has(channel.id) && (!projectWork || isTicketTargetChannel(channel)))
}

export const getLocalTimezone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const padNumber = (value: number): string => value.toString().padStart(2, '0')

export const toDatetimeLocalValue = (value?: string): string => {
  if (!value) return ''

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return ''
  }

  return [
    parsed.getFullYear(),
    padNumber(parsed.getMonth() + 1),
    padNumber(parsed.getDate()),
  ].join('-') +
    `T${padNumber(parsed.getHours())}:${padNumber(parsed.getMinutes())}`
}

const toIsoString = (value: string): string | undefined => {
  if (!value) return undefined

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

const toEventNamesValue = (config: Record<string, unknown>): string => {
  if (!Array.isArray(config.events)) {
    return ''
  }

  return config.events
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
}

const toEventFilterValue = (config: Record<string, unknown>): string => {
  if (!config.filter || typeof config.filter !== 'object' || Array.isArray(config.filter)) {
    return ''
  }

  return JSON.stringify(config.filter, null, 2)
}

export const getDefaultCreateState = (
  agents: AgentRecord[],
  channels: ChannelRecord[],
  workflowInstallations: WorkflowInstallationRecord[],
  defaultTarget?: DefaultTarget,
): TriggerFormState => {
  const firstBoundAgent =
    agents.find((candidate) => candidate.channelIds.length > 0) ?? agents[0]
  const firstWorkflowInstallation = workflowInstallations[0]

  const defaultTargetKind: TriggerTargetKind =
    defaultTarget?.targetKind ??
    (firstWorkflowInstallation ? 'workflow' : 'agent')

  const agentId =
    defaultTarget?.targetKind === 'agent'
      ? defaultTarget.agentId
      : firstBoundAgent?.id ?? ''
  const workflowInstallationId =
    defaultTarget?.targetKind === 'workflow'
      ? defaultTarget.workflowInstallationId
      : firstWorkflowInstallation?.id ?? ''
  const boundChannelIds = new Set(
    agents.find((candidate) => candidate.id === agentId)?.channelIds ?? [],
  )
  const firstChannelId = channels.find((candidate) => boundChannelIds.has(candidate.id))?.id
  const prefill = defaultTarget?.targetKind === 'agent' ? defaultTarget.prefill : undefined

  return {
    name: prefill?.name ?? '',
    description: '',
    enabled: true,
    targetKind: defaultTargetKind,
    agentId,
    workflowInstallationId,
    targetChannelId:
      defaultTarget?.targetKind === 'agent'
        ? (defaultTarget.targetChannelId ?? firstChannelId ?? '')
        : firstChannelId ?? '',
    triggerType: prefill?.triggerType ?? 'manual',
    ticket: getDefaultTicketState(prefill?.triggerType === 'ticket_changed' ? prefill.ticket : undefined),
    document: getDefaultDocumentState(prefill?.triggerType === 'document_changed' ? prefill.document : undefined),
    scheduleMode: 'once',
    nextRunAt: '',
    rollingStatus: false,
    cron: '',
    timezone: getLocalTimezone(),
    intervalMinutes: '60',
    until: '',
    eventNames: '',
    eventFilter: '',
  }
}

export const getEditState = (
  trigger: AgentTriggerRecord,
  channels: ChannelRecord[],
): TriggerFormState => {
  const config =
    trigger.config && typeof trigger.config === 'object' && !Array.isArray(trigger.config)
      ? trigger.config
      : {}
  const hasCron = typeof config.cron === 'string' && config.cron.trim().length > 0
  const boundChannelIds = new Set<string>(channels.map((candidate) => candidate.id))

  return {
    name: trigger.name ?? '',
    description: trigger.description ?? '',
    enabled: trigger.enabled,
    targetKind: trigger.agentId ? 'agent' : 'workflow',
    agentId: trigger.agentId ?? '',
    workflowInstallationId: trigger.workflowInstallationId ?? '',
    targetChannelId:
      trigger.targetChannelId && boundChannelIds.has(trigger.targetChannelId)
        ? trigger.targetChannelId
        : '',
    triggerType: trigger.type,
    scheduleMode: hasCron ? 'cron' : 'once',
    nextRunAt: toDatetimeLocalValue(trigger.nextRunAt),
    rollingStatus: config.rollingStatus === true,
    cron: typeof config.cron === 'string' ? config.cron : '',
    timezone: typeof config.timezone === 'string' ? config.timezone : getLocalTimezone(),
    intervalMinutes:
      typeof config.interval_minutes === 'number' ? `${config.interval_minutes}` : '60',
    until:
      typeof config.until === 'string' ? toDatetimeLocalValue(config.until) : '',
    eventNames: toEventNamesValue(config),
    eventFilter: toEventFilterValue(config),
    ticket: trigger.type === 'ticket_changed' ? ticketStateFromConfig(config) : getDefaultTicketState(),
    document: trigger.type === 'document_changed' ? documentStateFromConfig(config) : getDefaultDocumentState(),
  }
}

/**
 * Label for the form's current type selection (unlike the record-based
 * `getTriggerTypeLabel` in trigger-presentation, this reflects the not-yet-
 * saved schedule mode).
 */
export const getFormTriggerTypeLabel = (input: {
  scheduleMode?: ScheduleMode
  type: AgentTriggerRecord['type']
}): string => {
  if (input.type === 'manual') return 'Manual start'
  if (input.type === 'scheduled') {
    return input.scheduleMode === 'cron' ? 'Cron schedule' : 'One-off schedule'
  }
  if (input.type === 'interval') return 'Repeating interval'
  if (input.type === 'webhook') return 'Webhook'
  if (input.type === 'ticket_changed') return 'Ticket change'
  if (input.type === 'document_changed') return 'Document change'
  return 'System event'
}

export type BuildSubmitResult =
  | { payload: SubmitPayload }
  | { error: string; field?: TicketFormField | DocumentFormField }

/**
 * Validate the form and produce the API submit payload. Returns either a
 * `payload` or an `error` message; callers surface the error via form state.
 */
export const buildSubmitPayload = (
  form: TriggerFormState,
  mode: 'create' | 'edit',
  trigger?: AgentTriggerRecord,
): BuildSubmitResult => {
  const name = form.name.trim()
  if (!name) {
    return { error: 'Trigger name is required.' }
  }

  const description = form.description.trim()

  if (form.triggerType === 'manual') {
    return {
      payload: {
        name,
        description: description || undefined,
        enabled: form.enabled,
      },
    }
  }

  if (form.triggerType === 'scheduled') {
    if (mode === 'edit' && trigger?.type === 'scheduled') {
      if (form.scheduleMode === 'cron') {
        if (!form.cron.trim()) {
          return { error: 'Cron expression is required.' }
        }

        return {
          payload: {
            name,
            description: description || undefined,
            enabled: form.enabled,
            config: {
              cron: form.cron.trim(),
              timezone: form.timezone.trim() || getLocalTimezone(),
              rollingStatus: form.rollingStatus,
            },
          },
        }
      }

      const editNextRunAt = toIsoString(form.nextRunAt)
      if (!editNextRunAt) {
        return { error: 'Choose a date and time for the one-off schedule.' }
      }

      return {
        payload: {
          name,
          description: description || undefined,
          enabled: form.enabled,
          nextRunAt: editNextRunAt,
        },
      }
    }

    if (form.scheduleMode === 'cron') {
      if (!form.cron.trim()) {
        return { error: 'Cron expression is required.' }
      }

      return {
        payload: {
          name,
          description: description || undefined,
          enabled: form.enabled,
          config: {
            cron: form.cron.trim(),
            timezone: form.timezone.trim() || getLocalTimezone(),
            rollingStatus: form.rollingStatus,
          },
        },
      }
    }

    const nextRunAt = toIsoString(form.nextRunAt)
    if (!nextRunAt) {
      return { error: 'Choose a date and time for the one-off schedule.' }
    }

    return {
      payload: {
        name,
        description: description || undefined,
        enabled: form.enabled,
        nextRunAt,
      },
    }
  }

  if (form.triggerType === 'interval') {
    const intervalMinutes = Number.parseInt(form.intervalMinutes, 10)
    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
      return { error: 'Interval must be a whole number of minutes.' }
    }

    const nextRunAt = toIsoString(form.nextRunAt)

    return {
      payload: {
        name,
        description: description || undefined,
        enabled: form.enabled,
        config: {
          interval_minutes: intervalMinutes,
          rollingStatus: form.rollingStatus,
          ...(toIsoString(form.until) ? { until: toIsoString(form.until) } : {}),
        },
        nextRunAt,
      },
    }
  }

  if (form.triggerType === 'webhook') {
    return {
      payload: {
        name,
        description: description || undefined,
        enabled: form.enabled,
      },
    }
  }

  if (form.triggerType === 'ticket_changed') {
    const built = buildTicketConfig(form.ticket ?? getDefaultTicketState())
    if ('error' in built) return built
    return {
      payload: {
        name,
        description: description || undefined,
        enabled: form.enabled,
        config: built.config,
      },
    }
  }

  // Its own typed config, create or edit — never the event branch below, which
  // would overwrite it with an event list.
  if (form.triggerType === 'document_changed') {
    const built = buildDocumentConfig(form.document ?? getDefaultDocumentState(), mode)
    if ('error' in built) return built
    return {
      payload: {
        name,
        description: description || undefined,
        enabled: form.enabled,
        config: built.config,
      },
    }
  }

  const events = form.eventNames
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)
  if (events.length === 0) {
    return { error: 'Add at least one event name.' }
  }

  let filter: Record<string, unknown> | undefined
  const trimmedFilter = form.eventFilter.trim()
  if (trimmedFilter) {
    try {
      const parsed = JSON.parse(trimmedFilter) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: 'Event filter must be a JSON object.' }
      }
      filter = parsed as Record<string, unknown>
    } catch {
      return { error: 'Event filter must be valid JSON.' }
    }
  }

  return {
    payload: {
      name,
      description: description || undefined,
      enabled: form.enabled,
      config: {
        events,
        ...(filter ? { filter } : {}),
      },
    },
  }
}

export const fieldLabelClass =
  'text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]'
