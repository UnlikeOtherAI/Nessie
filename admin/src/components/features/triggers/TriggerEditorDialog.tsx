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
  fieldLabelClass,
  getDefaultCreateState,
  getEditState,
  getFormTriggerTypeLabel,
  type DefaultTarget,
  type TriggerFormState,
} from './trigger-config'
import { EventTriggerFields } from './EventTriggerFields'
import { IntervalTriggerFields } from './IntervalTriggerFields'
import { ScheduledTriggerFields } from './ScheduledTriggerFields'
import { TriggerMetaFields } from './TriggerMetaFields'
import { WebhookTriggerFields } from './WebhookTriggerFields'
import { draftKey, useDraft } from '../../../navigation/useDraft'
import { Notice } from '../../primitives/Notice'
import { Switch } from '../../primitives/Switch'
import { Dialog } from '../../shared/Dialog'

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

  // The trigger as stored (or the create defaults) — the draft's baseline, so a
  // dialog opened and dismissed untouched leaves nothing behind.
  const baseline = useMemo<TriggerFormState>(
    () =>
      trigger
        ? getEditState(trigger, channels)
        : getDefaultCreateState(agents, channels, workflowInstallations, defaultTarget),
    [agents, channels, defaultTarget, trigger, workflowInstallations],
  )

  // Drafts (docs/navigation/overview.md → "Drafts"): a half-configured schedule survives
  // a dismissal, keyed by the trigger being edited. Local only — a debounced
  // PUT would re-arm a live schedule on every keystroke, so Save stays the act
  // that changes when something fires.
  const triggerDraft = useDraft<TriggerFormState>(
    open ? draftKey('trigger', trigger?.id ?? 'new') : null,
    { initial: baseline },
  )
  const form = triggerDraft.draft
  const setForm = triggerDraft.setDraft

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

  // The draft hook seeds the form (from its stored row, else the baseline)
  // whenever the key changes; opening only has to clear the last error.
  useEffect(() => {
    if (!open) return
    setFormError(null)
  }, [open, trigger])

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
    setForm,
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
  }, [form.targetKind, selectedWorkflowInstallation, setForm, workflowInstallations])

  // Dismissing is not discarding: the draft stays under this trigger's key.
  const handleClose = () => {
    setFormError(null)
    onClose()
  }

  const closeSaved = () => {
    triggerDraft.clear()
    setFormError(null)
    onClose()
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
        closeSaved()
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
        closeSaved()
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
      closeSaved()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to save trigger.')
    }
  }

  const currentTriggerLabel = getFormTriggerTypeLabel({
    type: form.triggerType,
    scheduleMode: form.scheduleMode,
  })
  const showTargetChooser = mode === 'create'
  const showAgentTarget = showTargetChooser && form.targetKind === 'agent'
  const showWorkflowTarget = showTargetChooser && form.targetKind === 'workflow'
  const webhookBaseUrl = getBaseUrl() || window.location.origin.replace(/\/$/, '')
  const webhookUrl = `${webhookBaseUrl}/api/triggers/webhook`

  return (
    // `size="lg"` (640px) rather than a new size token for this dialog's
    // original 680px panel — close enough, per the kit. The scrolling form
    // sizes with `dvh`, the dynamic viewport a soft keyboard shrinks
    // (docs/navigation/overview.md §12).
    <Dialog
      description={
        mode === 'edit'
          ? `${currentTriggerLabel} configuration`
          : 'Choose what wakes up an agent or workflow and how it should run.'
      }
      dismissDisabled={isSubmitting}
      initialFocusRef={nameInputRef}
      onClose={handleClose}
      open={open}
      size="lg"
      title={mode === 'edit' ? 'Edit trigger' : 'Create a trigger'}
    >
      <form className="grid max-h-[80dvh] gap-4 overflow-y-auto pr-1" onSubmit={handleSubmit}>
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

          <div className="grid gap-1.5">
            <label className={fieldLabelClass} htmlFor="trigger-description">
              Description <span className="normal-case tracking-normal opacity-70">(optional)</span>
            </label>
            <textarea
              className="admin-input min-h-20"
              id="trigger-description"
              onChange={(nextEvent) =>
                setForm((current) => ({
                  ...current,
                  description: nextEvent.target.value,
                }))
              }
              placeholder="Notes for operators"
              value={form.description}
            />
          </div>

          {formError ? (
            <Notice padding="lg" radius="xl" tone="danger">{formError}</Notice>
          ) : null}

          <div className="flex items-center justify-between gap-3 pt-1">
            <label className="flex items-center gap-2 text-sm text-[color:var(--tx2)]">
              <Switch
                checked={form.enabled}
                label={form.enabled ? 'Disable trigger' : 'Enable trigger'}
                onChange={(next) =>
                  setForm((current) => ({ ...current, enabled: next }))
                }
              />
              Enabled
            </label>
            <div className="flex gap-2">
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
          </div>
      </form>
    </Dialog>
  )
}
