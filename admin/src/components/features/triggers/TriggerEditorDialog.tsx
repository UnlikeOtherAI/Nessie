import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  useCreateAgentTrigger,
  useCreateWorkflowInstallationTrigger,
  useUpdateTrigger,
} from '../../../facades/triggers/hooks'
import type {
  AgentRecord,
  AgentTriggerRecord,
  ChannelRecord,
  WorkflowInstallationRecord,
  WorkflowTemplateRecord,
} from '../../../lib/api-client'
import { getBaseUrl } from '../../../lib/api-client'

type TriggerEditorDialogProps = {
  agents: AgentRecord[]
  channels: ChannelRecord[]
  defaultTarget?:
    | {
        agentId: string
        targetChannelId?: string
        targetKind: 'agent'
      }
    | {
        targetKind: 'workflow'
        workflowInstallationId: string
      }
  onClose: () => void
  onSaved: (trigger: AgentTriggerRecord) => void
  open: boolean
  trigger?: AgentTriggerRecord
  workflowInstallations: WorkflowInstallationRecord[]
  workflowTemplates: WorkflowTemplateRecord[]
}

type TriggerTargetKind = 'agent' | 'workflow'
type ScheduleMode = 'cron' | 'once'
type TriggerFormState = {
  description: string
  enabled: boolean
  eventFilter: string
  eventNames: string
  intervalMinutes: string
  name: string
  nextRunAt: string
  scheduleMode: ScheduleMode
  targetChannelId: string
  targetKind: TriggerTargetKind
  triggerType: AgentTriggerRecord['type']
  workflowInstallationId: string
  cron: string
  timezone: string
  agentId: string
}

type SubmitPayload = {
  config?: Record<string, unknown>
  description?: string
  enabled: boolean
  name: string
  nextRunAt?: string
}

const fieldLabelClass =
  'text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]'

const getLocalTimezone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const padNumber = (value: number): string => value.toString().padStart(2, '0')

const toDatetimeLocalValue = (value?: string): string => {
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

const getDefaultCreateState = (
  agents: AgentRecord[],
  channels: ChannelRecord[],
  workflowInstallations: WorkflowInstallationRecord[],
  defaultTarget?: TriggerEditorDialogProps['defaultTarget'],
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

  return {
    name: '',
    description: '',
    enabled: true,
    targetKind: defaultTargetKind,
    agentId,
    workflowInstallationId,
    targetChannelId:
      defaultTarget?.targetKind === 'agent'
        ? (defaultTarget.targetChannelId ?? firstChannelId ?? '')
        : firstChannelId ?? '',
    triggerType: 'manual',
    scheduleMode: 'once',
    nextRunAt: '',
    cron: '',
    timezone: getLocalTimezone(),
    intervalMinutes: '60',
    eventNames: '',
    eventFilter: '',
  }
}

const getEditState = (
  trigger: AgentTriggerRecord,
  channels: ChannelRecord[],
): TriggerFormState => {
  const config =
    trigger.config && typeof trigger.config === 'object' && !Array.isArray(trigger.config)
      ? trigger.config
      : {}
  const hasCron = typeof config.cron === 'string' && config.cron.trim().length > 0
  const boundChannelIds = new Set(channels.map((candidate) => candidate.id))

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
    cron: typeof config.cron === 'string' ? config.cron : '',
    timezone: typeof config.timezone === 'string' ? config.timezone : getLocalTimezone(),
    intervalMinutes:
      typeof config.interval_minutes === 'number' ? `${config.interval_minutes}` : '60',
    eventNames: toEventNamesValue(config),
    eventFilter: toEventFilterValue(config),
  }
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

const getTriggerTypeLabel = (input: {
  scheduleMode?: ScheduleMode
  type: AgentTriggerRecord['type']
}): string => {
  if (input.type === 'manual') return 'Manual start'
  if (input.type === 'scheduled') {
    return input.scheduleMode === 'cron' ? 'Cron schedule' : 'One-off schedule'
  }
  if (input.type === 'interval') return 'Repeating interval'
  if (input.type === 'webhook') return 'Webhook'
  return 'System event'
}

export const TriggerEditorDialog = ({
  agents,
  channels,
  defaultTarget,
  onClose,
  onSaved,
  open,
  trigger,
  workflowInstallations,
  workflowTemplates,
}: TriggerEditorDialogProps) => {
  const nameInputRef = useRef<HTMLInputElement>(null)
  const createAgentTrigger = useCreateAgentTrigger()
  const createWorkflowTrigger = useCreateWorkflowInstallationTrigger()
  const updateTrigger = useUpdateTrigger()
  const [formError, setFormError] = useState<string | null>(null)
  const [form, setForm] = useState<TriggerFormState>(() =>
    trigger
      ? getEditState(trigger, channels)
      : getDefaultCreateState(agents, channels, workflowInstallations, defaultTarget),
  )

  const mode = trigger ? 'edit' : 'create'

  const templatesById = useMemo(
    () => new Map(workflowTemplates.map((template) => [template.id, template])),
    [workflowTemplates],
  )

  const selectedAgent = useMemo(
    () => agents.find((candidate) => candidate.id === form.agentId),
    [agents, form.agentId],
  )

  const agentChannels = useMemo(() => {
    const boundChannelIds = new Set(selectedAgent?.channelIds ?? [])
    return channels.filter((candidate) => boundChannelIds.has(candidate.id))
  }, [channels, selectedAgent])

  const selectedWorkflowInstallation = useMemo(
    () =>
      workflowInstallations.find(
        (candidate) => candidate.id === form.workflowInstallationId,
      ),
    [form.workflowInstallationId, workflowInstallations],
  )

  const isSubmitting =
    createAgentTrigger.isPending ||
    createWorkflowTrigger.isPending ||
    updateTrigger.isPending

  useEffect(() => {
    if (!open) return

    nameInputRef.current?.focus()
    setFormError(null)
    setForm(
      trigger
        ? getEditState(trigger, channels)
        : getDefaultCreateState(agents, channels, workflowInstallations, defaultTarget),
    )
  }, [agents, channels, defaultTarget, open, trigger, workflowInstallations])

  useEffect(() => {
    if (form.targetKind !== 'agent') {
      return
    }

    if (!selectedAgent && agents.length > 0) {
      const fallbackAgent =
        agents.find((candidate) => candidate.channelIds.length > 0) ?? agents[0]
      setForm((current) => ({
        ...current,
        agentId: fallbackAgent?.id ?? current.agentId,
      }))
      return
    }

    if (agentChannels.length === 0) {
      if (form.targetChannelId) {
        setForm((current) => ({ ...current, targetChannelId: '' }))
      }
      return
    }

    if (!agentChannels.some((candidate) => candidate.id === form.targetChannelId)) {
      setForm((current) => ({
        ...current,
        targetChannelId: agentChannels[0]?.id ?? '',
      }))
    }
  }, [
    agentChannels,
    agents,
    form.targetChannelId,
    form.targetKind,
    selectedAgent,
  ])

  useEffect(() => {
    if (
      form.targetKind !== 'workflow' ||
      selectedWorkflowInstallation ||
      workflowInstallations.length === 0
    ) {
      return
    }

    setForm((current) => ({
      ...current,
      workflowInstallationId: workflowInstallations[0]?.id ?? '',
    }))
  }, [form.targetKind, selectedWorkflowInstallation, workflowInstallations])

  const handleClose = () => {
    setFormError(null)
    onClose()
  }

  const handleOverlayClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && !isSubmitting) {
      handleClose()
    }
  }

  const buildSubmitPayload = (): SubmitPayload | null => {
    const name = form.name.trim()
    if (!name) {
      setFormError('Trigger name is required.')
      return null
    }

    const description = form.description.trim()

    if (form.triggerType === 'manual') {
      return {
        name,
        description: description || undefined,
        enabled: form.enabled,
      }
    }

    if (form.triggerType === 'scheduled') {
      if (mode === 'edit' && trigger?.type === 'scheduled') {
        if (form.scheduleMode === 'cron') {
          if (!form.cron.trim()) {
            setFormError('Cron expression is required.')
            return null
          }

          return {
            name,
            description: description || undefined,
            enabled: form.enabled,
            config: {
              cron: form.cron.trim(),
              timezone: form.timezone.trim() || getLocalTimezone(),
            },
          }
        }

        const nextRunAt = toIsoString(form.nextRunAt)
        if (!nextRunAt) {
          setFormError('Choose a date and time for the one-off schedule.')
          return null
        }

        return {
          name,
          description: description || undefined,
          enabled: form.enabled,
          nextRunAt,
        }
      }

      if (form.scheduleMode === 'cron') {
        if (!form.cron.trim()) {
          setFormError('Cron expression is required.')
          return null
        }

        return {
          name,
          description: description || undefined,
          enabled: form.enabled,
          config: {
            cron: form.cron.trim(),
            timezone: form.timezone.trim() || getLocalTimezone(),
          },
        }
      }

      const nextRunAt = toIsoString(form.nextRunAt)
      if (!nextRunAt) {
        setFormError('Choose a date and time for the one-off schedule.')
        return null
      }

      return {
        name,
        description: description || undefined,
        enabled: form.enabled,
        nextRunAt,
      }
    }

    if (form.triggerType === 'interval') {
      const intervalMinutes = Number.parseInt(form.intervalMinutes, 10)
      if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
        setFormError('Interval must be a whole number of minutes.')
        return null
      }

      const nextRunAt = toIsoString(form.nextRunAt)

      return {
        name,
        description: description || undefined,
        enabled: form.enabled,
        config: {
          interval_minutes: intervalMinutes,
        },
        nextRunAt,
      }
    }

    if (form.triggerType === 'webhook') {
      return {
        name,
        description: description || undefined,
        enabled: form.enabled,
      }
    }

    const events = form.eventNames
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)
    if (events.length === 0) {
      setFormError('Add at least one event name.')
      return null
    }

    let filter: Record<string, unknown> | undefined
    const trimmedFilter = form.eventFilter.trim()
    if (trimmedFilter) {
      try {
        const parsed = JSON.parse(trimmedFilter) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setFormError('Event filter must be a JSON object.')
          return null
        }
        filter = parsed as Record<string, unknown>
      } catch {
        setFormError('Event filter must be valid JSON.')
        return null
      }
    }

    return {
      name,
      description: description || undefined,
      enabled: form.enabled,
      config: {
        events,
        ...(filter ? { filter } : {}),
      },
    }
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError(null)

    const payload = buildSubmitPayload()
    if (!payload) {
      return
    }

    try {
      if (mode === 'edit' && trigger) {
        const updated = await updateTrigger.mutateAsync({
          triggerId: trigger.id,
          name: payload.name,
          description: payload.description ?? null,
          enabled: payload.enabled,
          config: payload.config,
          nextRunAt: payload.nextRunAt ?? undefined,
          ...(trigger.agentId && form.targetChannelId
            ? { targetChannelId: form.targetChannelId }
            : {}),
        })
        onSaved(updated)
        handleClose()
        return
      }

      if (form.targetKind === 'agent') {
        if (!form.agentId) {
          setFormError('Choose an agent target.')
          return
        }
        if (!form.targetChannelId) {
          setFormError('Choose a channel for the agent trigger.')
          return
        }

        const created = await createAgentTrigger.mutateAsync({
          agentId: form.agentId,
          type: form.triggerType,
          name: payload.name,
          description: payload.description,
          enabled: payload.enabled,
          config: payload.config,
          nextRunAt: payload.nextRunAt,
          targetChannelId: form.targetChannelId,
        })
        onSaved(created)
        handleClose()
        return
      }

      if (!form.workflowInstallationId) {
        setFormError('Choose a workflow target.')
        return
      }

      const created = await createWorkflowTrigger.mutateAsync({
        installationId: form.workflowInstallationId,
        type: form.triggerType,
        name: payload.name,
        description: payload.description,
        enabled: payload.enabled,
        config: payload.config,
        nextRunAt: payload.nextRunAt,
      })
      onSaved(created)
      handleClose()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to save trigger.')
    }
  }

  if (!open) {
    return null
  }

  const currentTriggerLabel = getTriggerTypeLabel({
    type: form.triggerType,
    scheduleMode: form.scheduleMode,
  })
  const showTargetChooser = mode === 'create'
  const showAgentTarget = showTargetChooser && form.targetKind === 'agent'
  const showWorkflowTarget = showTargetChooser && form.targetKind === 'workflow'
  const webhookBaseUrl = getBaseUrl() || window.location.origin.replace(/\/$/, '')
  const webhookUrl =
    trigger?.type === 'webhook'
      ? `${webhookBaseUrl}/api/triggers/webhook`
      : `${webhookBaseUrl}/api/triggers/webhook`

  return (
    <div
      onClick={handleOverlayClick}
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        className="create-channel-panel"
        style={{ maxWidth: 680 }}
      >
        <div className="create-channel-header">
          <div>
            <h2 className="text-lg font-bold text-white">
              {mode === 'edit' ? 'Edit trigger' : 'Create a trigger'}
            </h2>
            <div className="mt-1 text-sm text-[color:var(--tx3)]">
              {mode === 'edit'
                ? `${currentTriggerLabel} configuration`
                : 'Choose what wakes up an agent or workflow and how it should run.'}
            </div>
          </div>
          <button
            className={[
              'flex h-7 w-7 items-center justify-center',
              'rounded text-[color:var(--tx3)]',
              'hover:bg-white/10 hover:text-white',
            ].join(' ')}
            disabled={isSubmitting}
            onClick={handleClose}
            type="button"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path
                d="M6 18L18 6M6 6l12 12"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <form className="grid max-h-[80vh] gap-4 overflow-y-auto pr-1" onSubmit={handleSubmit}>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-1.5 md:col-span-2">
              <label className={fieldLabelClass} htmlFor="trigger-name">
                Trigger name
              </label>
              <input
                ref={nameInputRef}
                autoComplete="off"
                className="admin-input"
                id="trigger-name"
                onChange={(nextEvent) =>
                  setForm((current) => ({ ...current, name: nextEvent.target.value }))
                }
                placeholder="e.g. Daily pipeline check"
                value={form.name}
              />
            </div>

            <div className="grid gap-1.5 md:col-span-2">
              <label className={fieldLabelClass} htmlFor="trigger-description">
                Description
              </label>
              <textarea
                className="admin-input min-h-24 resize-y"
                id="trigger-description"
                onChange={(nextEvent) =>
                  setForm((current) => ({
                    ...current,
                    description: nextEvent.target.value,
                  }))
                }
                placeholder="Optional notes for operators"
                value={form.description}
              />
            </div>

            {showTargetChooser ? (
              <>
                <div className="grid gap-1.5">
                  <label className={fieldLabelClass} htmlFor="trigger-target-kind">
                    Target kind
                  </label>
                  <select
                    className="admin-input"
                    id="trigger-target-kind"
                    onChange={(nextEvent) =>
                      setForm((current) => ({
                        ...current,
                        targetKind: nextEvent.target.value as TriggerTargetKind,
                      }))
                    }
                    value={form.targetKind}
                  >
                    {workflowInstallations.length > 0 ? (
                      <option value="workflow">Workflow</option>
                    ) : null}
                    {agents.length > 0 ? <option value="agent">Agent</option> : null}
                  </select>
                </div>

                <div className="grid gap-1.5">
                  <label className={fieldLabelClass} htmlFor="trigger-enabled">
                    Status
                  </label>
                  <label className="flex h-full items-center gap-3 rounded-lg border border-[color:var(--sep)] bg-black/10 px-3 py-2 text-sm text-white">
                    <input
                      checked={form.enabled}
                      className="accent-[#7c3aed]"
                      id="trigger-enabled"
                      onChange={(nextEvent) =>
                        setForm((current) => ({
                          ...current,
                          enabled: nextEvent.target.checked,
                        }))
                      }
                      type="checkbox"
                    />
                    Start enabled
                  </label>
                </div>
              </>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <div className={fieldLabelClass}>Target</div>
                  <div className="admin-input cursor-default opacity-70">
                    {trigger?.agentId
                      ? selectedAgent?.name ?? `Agent ${trigger.agentId.slice(0, 8)}`
                      : selectedWorkflowInstallation
                        ? getWorkflowInstallationLabel(
                            selectedWorkflowInstallation,
                            templatesById,
                          )
                        : trigger?.workflowInstallationId
                          ? `Workflow ${trigger.workflowInstallationId.slice(0, 8)}`
                          : 'Unknown'}
                  </div>
                </div>

                <div className="grid gap-1.5">
                  <div className={fieldLabelClass}>Status</div>
                  <label className="flex h-full items-center gap-3 rounded-lg border border-[color:var(--sep)] bg-black/10 px-3 py-2 text-sm text-white">
                    <input
                      checked={form.enabled}
                      className="accent-[#7c3aed]"
                      onChange={(nextEvent) =>
                        setForm((current) => ({
                          ...current,
                          enabled: nextEvent.target.checked,
                        }))
                      }
                      type="checkbox"
                    />
                    Start enabled
                  </label>
                </div>

                {trigger?.agentId ? (
                  <div className="grid gap-1.5 md:col-span-2">
                    <label className={fieldLabelClass} htmlFor="trigger-edit-channel">
                      Channel
                    </label>
                    <select
                      className="admin-input"
                      id="trigger-edit-channel"
                      onChange={(nextEvent) =>
                        setForm((current) => ({
                          ...current,
                          targetChannelId: nextEvent.target.value,
                        }))
                      }
                      value={form.targetChannelId}
                    >
                      {agentChannels.length === 0 ? (
                        <option value="">Bind this agent to a channel first</option>
                      ) : null}
                      {agentChannels.map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          {channel.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </>
            )}

            {showAgentTarget ? (
              <>
                <div className="grid gap-1.5">
                  <label className={fieldLabelClass} htmlFor="trigger-agent">
                    Agent
                  </label>
                  <select
                    className="admin-input"
                    id="trigger-agent"
                    onChange={(nextEvent) =>
                      setForm((current) => ({
                        ...current,
                        agentId: nextEvent.target.value,
                      }))
                    }
                    value={form.agentId}
                  >
                    {agents.length === 0 ? <option value="">No agents available</option> : null}
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid gap-1.5">
                  <label className={fieldLabelClass} htmlFor="trigger-channel">
                    Channel
                  </label>
                  <select
                    className="admin-input"
                    id="trigger-channel"
                    onChange={(nextEvent) =>
                      setForm((current) => ({
                        ...current,
                        targetChannelId: nextEvent.target.value,
                      }))
                    }
                    value={form.targetChannelId}
                  >
                    {agentChannels.length === 0 ? (
                      <option value="">Bind this agent to a channel first</option>
                    ) : null}
                    {agentChannels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        {channel.label}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            ) : null}

            {showWorkflowTarget ? (
              <div className="grid gap-1.5 md:col-span-2">
                <label className={fieldLabelClass} htmlFor="trigger-workflow-installation">
                  Workflow
                </label>
                <select
                  className="admin-input"
                  id="trigger-workflow-installation"
                  onChange={(nextEvent) =>
                    setForm((current) => ({
                      ...current,
                      workflowInstallationId: nextEvent.target.value,
                    }))
                  }
                  value={form.workflowInstallationId}
                >
                  {workflowInstallations.length === 0 ? (
                    <option value="">No workflow installations available</option>
                  ) : null}
                  {workflowInstallations.map((installation) => (
                    <option key={installation.id} value={installation.id}>
                      {getWorkflowInstallationLabel(installation, templatesById)}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="grid gap-1.5">
              <label className={fieldLabelClass} htmlFor="trigger-type">
                Trigger type
              </label>
              <select
                className="admin-input"
                disabled={mode === 'edit'}
                id="trigger-type"
                onChange={(nextEvent) =>
                  setForm((current) => ({
                    ...current,
                    triggerType: nextEvent.target.value as AgentTriggerRecord['type'],
                  }))
                }
                value={form.triggerType}
              >
                <option value="manual">Manual start</option>
                <option value="scheduled">Calendar / cron</option>
                <option value="interval">Repeating interval</option>
                <option value="webhook">Webhook</option>
                <option value="event">System event</option>
              </select>
            </div>

            {mode === 'edit' ? (
              <div className="grid gap-1.5">
                <div className={fieldLabelClass}>Mode</div>
                <div className="admin-input cursor-default opacity-70">
                  {currentTriggerLabel}
                </div>
              </div>
            ) : null}
          </div>

          {form.triggerType === 'scheduled' ? (
            <section className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="grid gap-1.5">
                  <label className={fieldLabelClass} htmlFor="trigger-schedule-mode">
                    Schedule mode
                  </label>
                  <select
                    className="admin-input"
                    disabled={mode === 'edit'}
                    id="trigger-schedule-mode"
                    onChange={(nextEvent) =>
                      setForm((current) => ({
                        ...current,
                        scheduleMode: nextEvent.target.value as ScheduleMode,
                      }))
                    }
                    value={form.scheduleMode}
                  >
                    <option value="once">One-off</option>
                    <option value="cron">Cron</option>
                  </select>
                </div>

                {form.scheduleMode === 'once' ? (
                  <div className="grid gap-1.5">
                    <label className={fieldLabelClass} htmlFor="trigger-next-run">
                      Run at
                    </label>
                    <input
                      className="admin-input"
                      id="trigger-next-run"
                      onChange={(nextEvent) =>
                        setForm((current) => ({
                          ...current,
                          nextRunAt: nextEvent.target.value,
                        }))
                      }
                      type="datetime-local"
                      value={form.nextRunAt}
                    />
                  </div>
                ) : (
                  <>
                    <div className="grid gap-1.5">
                      <label className={fieldLabelClass} htmlFor="trigger-cron">
                        Cron expression
                      </label>
                      <input
                        className="admin-input"
                        id="trigger-cron"
                        onChange={(nextEvent) =>
                          setForm((current) => ({
                            ...current,
                            cron: nextEvent.target.value,
                          }))
                        }
                        placeholder="0 9 * * 1-5"
                        value={form.cron}
                      />
                    </div>

                    <div className="grid gap-1.5">
                      <label className={fieldLabelClass} htmlFor="trigger-timezone">
                        Timezone
                      </label>
                      <input
                        className="admin-input"
                        id="trigger-timezone"
                        onChange={(nextEvent) =>
                          setForm((current) => ({
                            ...current,
                            timezone: nextEvent.target.value,
                          }))
                        }
                        placeholder="Europe/London"
                        value={form.timezone}
                      />
                    </div>
                  </>
                )}
              </div>
            </section>
          ) : null}

          {form.triggerType === 'interval' ? (
            <section className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="grid gap-1.5">
                  <label className={fieldLabelClass} htmlFor="trigger-interval-minutes">
                    Every N minutes
                  </label>
                  <input
                    className="admin-input"
                    id="trigger-interval-minutes"
                    min="1"
                    onChange={(nextEvent) =>
                      setForm((current) => ({
                        ...current,
                        intervalMinutes: nextEvent.target.value,
                      }))
                    }
                    step="1"
                    type="number"
                    value={form.intervalMinutes}
                  />
                </div>

                <div className="grid gap-1.5">
                  <label className={fieldLabelClass} htmlFor="trigger-interval-start">
                    First run
                  </label>
                  <input
                    className="admin-input"
                    id="trigger-interval-start"
                    onChange={(nextEvent) =>
                      setForm((current) => ({
                        ...current,
                        nextRunAt: nextEvent.target.value,
                      }))
                    }
                    type="datetime-local"
                    value={form.nextRunAt}
                  />
                </div>
              </div>
            </section>
          ) : null}

          {form.triggerType === 'webhook' ? (
            <section className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="grid gap-1.5 md:col-span-2">
                  <label className={fieldLabelClass} htmlFor="trigger-webhook-endpoint">
                    Shared endpoint
                  </label>
                  <input
                    className="admin-input cursor-default font-mono text-xs opacity-80"
                    disabled
                    id="trigger-webhook-endpoint"
                    value={webhookUrl}
                  />
                </div>

                <div className="grid gap-1.5">
                  <label className={fieldLabelClass} htmlFor="trigger-webhook-auth-header">
                    Auth header
                  </label>
                  <input
                    className="admin-input cursor-default font-mono text-xs opacity-80"
                    disabled
                    id="trigger-webhook-auth-header"
                    value="Authorization: Bearer <api-key>"
                  />
                </div>

                <div className="grid gap-1.5">
                  <label className={fieldLabelClass} htmlFor="trigger-webhook-fallback-header">
                    Alternate header
                  </label>
                  <input
                    className="admin-input cursor-default font-mono text-xs opacity-80"
                    disabled
                    id="trigger-webhook-fallback-header"
                    value="X-Nessie-Trigger-Key: <api-key>"
                  />
                </div>

                <div className="grid gap-1.5 md:col-span-2">
                  <label className={fieldLabelClass} htmlFor="trigger-webhook-api-key">
                    API key
                  </label>
                  <input
                    className="admin-input cursor-default font-mono text-xs opacity-80"
                    disabled
                    id="trigger-webhook-api-key"
                    value={
                      trigger?.webhookApiKey ??
                      (mode === 'create'
                        ? 'Generated automatically after creation'
                        : 'Save this trigger to generate an API key')
                    }
                  />
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-[color:var(--sep)] bg-black/10 px-3 py-3 text-sm text-[color:var(--tx3)]">
                Nessie routes every webhook call through this single endpoint and uses the
                trigger API key to identify which trigger should fire.
              </div>
            </section>
          ) : null}

          {form.triggerType === 'event' ? (
            <section className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4">
              <div className="grid gap-4">
                <div className="grid gap-1.5">
                  <label className={fieldLabelClass} htmlFor="trigger-event-names">
                    Event names
                  </label>
                  <textarea
                    className="admin-input min-h-24 resize-y font-mono text-xs"
                    id="trigger-event-names"
                    onChange={(nextEvent) =>
                      setForm((current) => ({
                        ...current,
                        eventNames: nextEvent.target.value,
                      }))
                    }
                    placeholder={'task.state_changed\nworkflow.completed'}
                    value={form.eventNames}
                  />
                </div>

                <div className="grid gap-1.5">
                  <label className={fieldLabelClass} htmlFor="trigger-event-filter">
                    Event filter JSON
                  </label>
                  <textarea
                    className="admin-input min-h-28 resize-y font-mono text-xs"
                    id="trigger-event-filter"
                    onChange={(nextEvent) =>
                      setForm((current) => ({
                        ...current,
                        eventFilter: nextEvent.target.value,
                      }))
                    }
                    placeholder={'{\n  "status": "failed"\n}'}
                    value={form.eventFilter}
                  />
                </div>
              </div>
            </section>
          ) : null}

          {formError ? (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-3 text-sm text-rose-200">
              {formError}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <button
              className="admin-button admin-button-secondary"
              disabled={isSubmitting}
              onClick={handleClose}
              type="button"
            >
              Cancel
            </button>
            <button
              className="admin-button admin-button-primary"
              disabled={isSubmitting}
              type="submit"
            >
              {isSubmitting
                ? mode === 'edit'
                  ? 'Saving...'
                  : 'Creating...'
                : mode === 'edit'
                  ? 'Save changes'
                  : 'Create trigger'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
