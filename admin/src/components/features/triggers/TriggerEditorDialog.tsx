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
import {
  buildSubmitPayload,
  getDefaultCreateState,
  getEditState,
  getTriggerTypeLabel,
  type DefaultTarget,
  type TriggerFormState,
} from './trigger-config'
import { EventTriggerFields } from './EventTriggerFields'
import { IntervalTriggerFields } from './IntervalTriggerFields'
import { ScheduledTriggerFields } from './ScheduledTriggerFields'
import { TriggerMetaFields } from './TriggerMetaFields'
import { WebhookTriggerFields } from './WebhookTriggerFields'

type TriggerEditorDialogProps = {
  agents: AgentRecord[]
  channels: ChannelRecord[]
  defaultTarget?: DefaultTarget
  onClose: () => void
  onSaved: (trigger: AgentTriggerRecord) => void
  open: boolean
  trigger?: AgentTriggerRecord
  workflowInstallations: WorkflowInstallationRecord[]
  workflowTemplates: WorkflowTemplateRecord[]
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

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError(null)

    const result = buildSubmitPayload(form, mode, trigger)
    if ('error' in result) {
      setFormError(result.error)
      return
    }
    const payload = result.payload

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
  const webhookUrl = `${webhookBaseUrl}/api/triggers/webhook`

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
          <TriggerMetaFields
            agentChannels={agentChannels}
            agents={agents}
            currentTriggerLabel={currentTriggerLabel}
            form={form}
            mode={mode}
            nameInputRef={nameInputRef}
            selectedAgent={selectedAgent}
            selectedWorkflowInstallation={selectedWorkflowInstallation}
            setForm={setForm}
            showAgentTarget={showAgentTarget}
            showTargetChooser={showTargetChooser}
            showWorkflowTarget={showWorkflowTarget}
            templatesById={templatesById}
            trigger={trigger}
            workflowInstallations={workflowInstallations}
          />

          {form.triggerType === 'scheduled' ? (
            <ScheduledTriggerFields
              form={form}
              isEditMode={mode === 'edit'}
              setForm={setForm}
            />
          ) : null}

          {form.triggerType === 'interval' ? (
            <IntervalTriggerFields form={form} setForm={setForm} />
          ) : null}

          {form.triggerType === 'webhook' ? (
            <WebhookTriggerFields mode={mode} trigger={trigger} webhookUrl={webhookUrl} />
          ) : null}

          {form.triggerType === 'event' ? (
            <EventTriggerFields form={form} setForm={setForm} />
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
