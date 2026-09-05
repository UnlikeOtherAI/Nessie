import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useRedirect } from '../../navigation/redirect'
import { useAgents } from '../../facades/agents/hooks'
import { useChannels } from '../../facades/channels/hooks'
import { useProjects } from '../../facades/projects/hooks'
import {
  useActivateStatus,
  useClearActiveStatus,
  useCreateStatus,
  useCreateStatusRule,
  useCreateStatusSchedule,
  useDeleteStatus,
  useDeleteStatusRule,
  useDeleteStatusSchedule,
  useStatuses,
  useUpdateStatus,
} from '../../facades/statuses/hooks'
import { usePhoneLayout } from '../../lib/mobile-shell'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
import { toFormErrors } from '../../facades/form-errors'
import { Card } from '../../components/shared/Card'
import { ConfirmDialog } from '../../components/shared/ConfirmDialog'
import { EmptyState } from '../../components/shared/EmptyState'
import { FormActions, FormError } from '../../components/shared/FormActions'
import { FormField } from '../../components/shared/FormField'
import { Input } from '../../components/shared/FormControls'
import { QueryState } from '../../components/shared/QueryState'
import { SettingsPanel } from './settings-shared'
import { SectionLabel } from '../../components/primitives/SectionLabel'
import { Switch } from '../../components/primitives/Switch'
import { Textarea } from '../../components/shared/FormControls'
import { StatusList } from './statuses/status-components'
import { StatusEmojiPicker } from './statuses/StatusEmojiPicker'
import { StatusRuleForm } from './statuses/StatusRuleForm'
import { StatusScheduleForm } from './statuses/StatusScheduleForm'

export const StatusesPage = () => {
  const { statusId } = useParams()
  const navigate = useNavigate()
  const phoneLayout = usePhoneLayout()
  const redirect = useRedirect()
  const statuses = useStatuses()
  const statusRows = statuses.data ?? []
  const { data: channels = [] } = useChannels()
  const { data: projects = [] } = useProjects()
  const { data: agents = [] } = useAgents()

  const createStatus = useCreateStatus()
  const updateStatus = useUpdateStatus()
  const deleteStatus = useDeleteStatus()
  const activateStatus = useActivateStatus()
  const clearActiveStatus = useClearActiveStatus()
  const createSchedule = useCreateStatusSchedule()
  const deleteSchedule = useDeleteStatusSchedule()
  const createRule = useCreateStatusRule()
  const deleteRule = useDeleteStatusRule()

  const selectedStatus = useMemo(
    () => statusRows.find((status) => status.id === statusId) ?? null,
    [statusId, statusRows],
  )

  const [newLabel, setNewLabel] = useState('')
  const [newEmoji, setNewEmoji] = useState('')
  const [createError, setCreateError] = useState<string | undefined>(undefined)
  const [label, setLabel] = useState('')
  const [emoji, setEmoji] = useState('')
  const [agentEnabled, setAgentEnabled] = useState(false)
  const [agentInstructions, setAgentInstructions] = useState('')
  const [saveError, setSaveError] = useState<string | undefined>(undefined)

  useEffect(() => {
    // A phone screen starts on the list: `/settings/statuses/:id` is a real
    // pushed screen in the navigation stack (surface registry, depth 2), so
    // auto-selecting the first status here would slide a detail in on arrival
    // and then re-slide it on every Back — the reader could never leave.
    // Wider layouts keep the convenience because the list stays beside it.
    if (!phoneLayout && !statusId && statusRows[0]) {
      redirect(`/settings/statuses/${statusRows[0].id}`)
    }
  }, [phoneLayout, redirect, statusId, statusRows])

  const [confirmingDelete, setConfirmingDelete] = useState(false)

  // Seed the editor once per selected status (key on id only). Keying on every
  // field would let a background ['statuses'] refetch — e.g. after toggling
  // active — overwrite the user's in-progress edits.
  useEffect(() => {
    setLabel(selectedStatus?.label ?? '')
    setEmoji(selectedStatus?.emoji ?? '')
    setAgentEnabled(selectedStatus?.agentEnabled ?? false)
    setAgentInstructions(selectedStatus?.agentInstructions ?? '')
    setSaveError(undefined)
  }, [selectedStatus?.id])

  const createStatusSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!newLabel.trim()) return
    setCreateError(undefined)
    try {
      const created = await createStatus.mutateAsync({
        emoji: newEmoji.trim() || null,
        label: newLabel.trim(),
      })
      setNewLabel('')
      setNewEmoji('')
      navigate(`/settings/statuses/${created.id}`)
    } catch (error) {
      const { fieldErrors, formError } = toFormErrors(error)
      setCreateError(fieldErrors.label ?? formError ?? 'Failed to create status.')
    }
  }

  const saveStatusSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedStatus || !label.trim()) return
    setSaveError(undefined)
    try {
      await updateStatus.mutateAsync({
        agentEnabled,
        agentInstructions: agentInstructions.trim() || null,
        emoji: emoji.trim() || null,
        label: label.trim(),
        statusId: selectedStatus.id,
      })
    } catch (error) {
      const { fieldErrors, formError } = toFormErrors(error)
      setSaveError(fieldErrors.label ?? formError ?? 'Failed to save status.')
    }
  }

  const deleteSelectedStatus = async () => {
    if (!selectedStatus) return
    setConfirmingDelete(false)
    await deleteStatus.mutateAsync(selectedStatus.id)
    navigate('/settings/statuses', { replace: true })
  }

  return (
    <SettingsPanel
      eyebrow="User"
      title="Statuses"
      actions={[
        {
          id: 'clear-active',
          label: 'Clear active',
          onSelect: () => clearActiveStatus.mutate(),
          priority: 100,
        } satisfies PageHeaderAction,
      ]}
    >
      <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        <Card as="section">
          <SectionLabel>Statuses</SectionLabel>
          <form className="mt-4 grid gap-3" onSubmit={createStatusSubmit}>
            <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-2">
              <FormField label="Icon">
                <StatusEmojiPicker label="New status icon" onChange={setNewEmoji} value={newEmoji} />
              </FormField>
              <FormField label="Label">
                <Input
                  onChange={(event) => setNewLabel(event.target.value)}
                  placeholder="New status"
                  value={newLabel}
                />
              </FormField>
            </div>
            <FormError>{createError}</FormError>
            <FormActions>
              <button className="admin-button admin-button-primary" type="submit">
                Add status
              </button>
            </FormActions>
          </form>
          <div className="mt-4">
            <QueryState
              errorLabel="Could not load statuses."
              loadingLabel="Loading statuses…"
              query={statuses}
            >
              {() => (
                statusRows.length > 0 ? (
                  <StatusList activeId={selectedStatus?.id} statuses={statusRows} />
                ) : (
                  <EmptyState>No statuses yet.</EmptyState>
                )
              )}
            </QueryState>
          </div>
        </Card>

        {selectedStatus ? (
          <section className="grid gap-4">
            <Card as="section">
              <form className="grid gap-4" onSubmit={saveStatusSubmit}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <SectionLabel>Status detail</SectionLabel>
                  <div className="mt-2 text-sm text-[color:var(--tx3)]">
                    {selectedStatus.activeNow ? 'Currently visible' : 'Not currently visible'}
                  </div>
                </div>
                <button
                  className="admin-button admin-button-secondary"
                  onClick={() => activateStatus.mutate(selectedStatus.id)}
                  type="button"
                >
                  Set active
                </button>
              </div>
              <div className="grid gap-3 md:grid-cols-[90px_minmax(0,1fr)]">
                <FormField label="Icon">
                  <StatusEmojiPicker label="Status icon" onChange={setEmoji} value={emoji} />
                </FormField>
                <FormField label="Label">
                  <Input
                    onChange={(event) => setLabel(event.target.value)}
                    placeholder="Status label"
                    value={label}
                  />
                </FormField>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="font-semibold text-[color:var(--tx)]">Enable response agent</div>
                  <div className="text-sm text-[color:var(--tx3)]">
                    Use these instructions when someone contacts you during this status.
                  </div>
                </div>
                <Switch
                  checked={agentEnabled}
                  label="Enable response agent"
                  onChange={setAgentEnabled}
                />
              </div>
              <FormField label="Agent instructions">
                <Textarea
                  className="min-h-28"
                  onChange={(event) => setAgentInstructions(event.target.value)}
                  placeholder="Agent instructions"
                  value={agentInstructions}
                />
              </FormField>
              <FormError>{saveError}</FormError>
              <FormActions
                destructive={
                  <button
                    className="admin-button admin-button-secondary admin-button-danger"
                    disabled={deleteStatus.isPending}
                    onClick={() => setConfirmingDelete(true)}
                    type="button"
                  >
                    Delete
                  </button>
                }
              >
                <button className="admin-button admin-button-primary" type="submit">
                  Save status
                </button>
              </FormActions>
              </form>
            </Card>

            <StatusScheduleForm
              createSchedule={createSchedule}
              deleteSchedule={deleteSchedule}
              selectedStatus={selectedStatus}
            />

            <StatusRuleForm
              agents={agents}
              channels={channels}
              createRule={createRule}
              deleteRule={deleteRule}
              projects={projects}
              selectedStatus={selectedStatus}
            />
          </section>
        ) : (
          <EmptyState>Create or select a status to edit schedules and contact rules.</EmptyState>
        )}
      </div>

      <ConfirmDialog
        body="This also removes its schedules and contact rules."
        confirmLabel="Delete"
        destructive
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => void deleteSelectedStatus()}
        open={confirmingDelete}
        pending={deleteStatus.isPending}
        title={selectedStatus ? `Delete "${selectedStatus.label}"?` : 'Delete this status?'}
      />
    </SettingsPanel>
  )
}
