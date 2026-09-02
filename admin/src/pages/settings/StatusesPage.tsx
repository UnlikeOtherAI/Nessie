import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Switch } from '../../components/primitives/Switch'
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
import type { UserStatusRuleScope, UserStatusScheduleKind } from '../../lib/api-client'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
import { toFormErrors } from '../../facades/form-errors'
import { Card } from '../../components/shared/Card'
import { ConfirmDialog } from '../../components/shared/ConfirmDialog'
import { EmptyState } from '../../components/shared/EmptyState'
import { FormActions, FormError } from '../../components/shared/FormActions'
import { FormField } from '../../components/shared/FormField'
import { Input, Select, Textarea } from '../../components/shared/FormControls'
import { QueryState } from '../../components/shared/QueryState'
import { Row, RowList } from '../../components/shared/RowList'
import { SettingsPanel } from './settings-shared'
import { SectionLabel } from '../../components/primitives/SectionLabel'
import {
  dayLabels,
  describeRule,
  describeSchedule,
  StatusList,
  toIsoFromLocal,
} from './statuses/status-components'
import { StatusEmojiPicker } from './statuses/StatusEmojiPicker'

export const StatusesPage = () => {
  const { statusId } = useParams()
  const navigate = useNavigate()
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
  const [scheduleKind, setScheduleKind] = useState<UserStatusScheduleKind>('weekly')
  const [scheduleLabel, setScheduleLabel] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [dayOfWeek, setDayOfWeek] = useState(1)
  const [startTime, setStartTime] = useState('12:00')
  const [endTime, setEndTime] = useState('13:00')
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [scheduleError, setScheduleError] = useState<string | undefined>(undefined)
  const [ruleScope, setRuleScope] = useState<UserStatusRuleScope>('fallback')
  const [ruleChannelId, setRuleChannelId] = useState('')
  const [ruleProjectId, setRuleProjectId] = useState('')
  const [ruleAgentId, setRuleAgentId] = useState('')
  const [ruleAgentEnabled, setRuleAgentEnabled] = useState(true)
  const [ruleInstructions, setRuleInstructions] = useState('')
  const [ruleError, setRuleError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!statusId && statusRows[0]) {
      navigate(`/settings/statuses/${statusRows[0].id}`, { replace: true })
    }
  }, [navigate, statusId, statusRows])

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

  const scheduleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedStatus) return
    setScheduleError(undefined)
    try {
      await createSchedule.mutateAsync(
        scheduleKind === 'date_range'
          ? {
              endsAt: toIsoFromLocal(endsAt),
              kind: scheduleKind,
              label: scheduleLabel.trim() || null,
              startsAt: toIsoFromLocal(startsAt),
              statusId: selectedStatus.id,
            }
          : {
              dayOfWeek,
              endTime,
              kind: scheduleKind,
              label: scheduleLabel.trim() || null,
              startTime,
              statusId: selectedStatus.id,
              timezone,
            },
      )
      setScheduleLabel('')
    } catch (error) {
      setScheduleError(toFormErrors(error).formError ?? 'Failed to add schedule.')
    }
  }

  const ruleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedStatus || !ruleInstructions.trim()) return
    setRuleError(undefined)
    try {
      await createRule.mutateAsync({
        agentEnabled: ruleAgentEnabled,
        agentId: ruleAgentId || null,
        channelId: ruleScope === 'channel' ? ruleChannelId || null : null,
        instructions: ruleInstructions.trim(),
        projectId: ruleScope === 'project' ? ruleProjectId || null : null,
        scope: ruleScope,
        statusId: selectedStatus.id,
      })
      setRuleInstructions('')
    } catch (error) {
      setRuleError(toFormErrors(error).formError ?? 'Failed to add rule.')
    }
  }

  const deleteSelectedStatus = async () => {
    if (!selectedStatus) return
    setConfirmingDelete(false)
    await deleteStatus.mutateAsync(selectedStatus.id)
    navigate('/settings/statuses', { replace: true })
  }

  const ruleTargetReady =
    ruleScope === 'fallback' ||
    (ruleScope === 'channel' && Boolean(ruleChannelId)) ||
    (ruleScope === 'project' && Boolean(ruleProjectId))

  return (
    <SettingsPanel
      eyebrow="Account"
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

            <Card as="section">
              <SectionLabel>Schedules</SectionLabel>
              <form className="mt-4 grid gap-3" onSubmit={scheduleSubmit}>
                <div className="grid gap-2 md:grid-cols-3">
                  <FormField label="Type">
                    <Select
                      onChange={(event) =>
                        setScheduleKind(event.target.value as UserStatusScheduleKind)}
                      value={scheduleKind}
                    >
                      <option value="weekly">Weekly</option>
                      <option value="date_range">Date range</option>
                    </Select>
                  </FormField>
                  <FormField className="md:col-span-2" label="Label (optional)">
                    <Input
                      onChange={(event) => setScheduleLabel(event.target.value)}
                      placeholder="Schedule label"
                      value={scheduleLabel}
                    />
                  </FormField>
                </div>
                {scheduleKind === 'date_range' ? (
                  <div className="grid gap-2 md:grid-cols-2">
                    <FormField label="Starts">
                      <Input
                        onChange={(event) => setStartsAt(event.target.value)}
                        required
                        type="datetime-local"
                        value={startsAt}
                      />
                    </FormField>
                    <FormField label="Ends">
                      <Input
                        onChange={(event) => setEndsAt(event.target.value)}
                        required
                        type="datetime-local"
                        value={endsAt}
                      />
                    </FormField>
                  </div>
                ) : (
                  <div className="grid gap-2 md:grid-cols-4">
                    <FormField label="Day">
                      <Select
                        onChange={(event) => setDayOfWeek(Number(event.target.value))}
                        value={dayOfWeek}
                      >
                        {dayLabels.map((day, index) => (
                          <option key={day} value={index}>
                            {day}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                    <FormField label="Start time">
                      <Input
                        onChange={(event) => setStartTime(event.target.value)}
                        type="time"
                        value={startTime}
                      />
                    </FormField>
                    <FormField label="End time">
                      <Input
                        onChange={(event) => setEndTime(event.target.value)}
                        type="time"
                        value={endTime}
                      />
                    </FormField>
                    <FormField label="Timezone">
                      <Input
                        onChange={(event) => setTimezone(event.target.value)}
                        value={timezone}
                      />
                    </FormField>
                  </div>
                )}
                <FormError>{scheduleError}</FormError>
                <FormActions>
                  <button className="admin-button admin-button-secondary" type="submit">
                    Add schedule
                  </button>
                </FormActions>
              </form>
              <div className="mt-4">
                {selectedStatus.schedules.length > 0 ? (
                  <RowList label="Schedules">
                    {selectedStatus.schedules.map((schedule) => (
                      <Row
                        key={schedule.id}
                        subtitle={describeSchedule(schedule)}
                        title={schedule.label || (schedule.kind === 'weekly' ? 'Weekly' : 'Date range')}
                        trailing={
                          <button
                            className="admin-button admin-button-secondary"
                            onClick={() =>
                              deleteSchedule.mutate({
                                scheduleId: schedule.id,
                                statusId: selectedStatus.id,
                              })}
                            type="button"
                          >
                            Remove
                          </button>
                        }
                      />
                    ))}
                  </RowList>
                ) : (
                  <EmptyState>No schedules yet — this status only applies when set active.</EmptyState>
                )}
              </div>
            </Card>

            <Card as="section">
              <SectionLabel>Contact rules</SectionLabel>
              <form className="mt-4 grid gap-3" onSubmit={ruleSubmit}>
                <div className="grid gap-2 md:grid-cols-3">
                  <FormField label="Applies to">
                    <Select
                      onChange={(event) => setRuleScope(event.target.value as UserStatusRuleScope)}
                      value={ruleScope}
                    >
                      <option value="fallback">Everyone</option>
                      <option value="channel">Channel</option>
                      <option value="project">Project</option>
                    </Select>
                  </FormField>
                  {ruleScope === 'channel' && (
                    <FormField className="md:col-span-2" label="Channel">
                      <Select
                        onChange={(event) => setRuleChannelId(event.target.value)}
                        value={ruleChannelId}
                      >
                        <option value="">Select channel</option>
                        {channels.map((channel) => (
                          <option key={channel.id} value={channel.id}>
                            {channel.label}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                  )}
                  {ruleScope === 'project' && (
                    <FormField className="md:col-span-2" label="Project">
                      <Select
                        onChange={(event) => setRuleProjectId(event.target.value)}
                        value={ruleProjectId}
                      >
                        <option value="">Select project</option>
                        {projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                  )}
                </div>
                <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
                  <FormField label="Agent">
                    <Select
                      onChange={(event) => setRuleAgentId(event.target.value)}
                      value={ruleAgentId}
                    >
                      <option value="">Default status agent</option>
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <div className="flex items-center gap-3 self-end pb-2">
                    <span className="text-sm text-[color:var(--tx2)]">Agent replies</span>
                    <Switch
                      checked={ruleAgentEnabled}
                      label="Enable rule agent"
                      onChange={setRuleAgentEnabled}
                    />
                  </div>
                </div>
                <FormField label="Instructions">
                  <Textarea
                    className="min-h-24"
                    onChange={(event) => setRuleInstructions(event.target.value)}
                    placeholder="Rule-specific instructions"
                    value={ruleInstructions}
                  />
                </FormField>
                <FormError>{ruleError}</FormError>
                <FormActions>
                  <button
                    className="admin-button admin-button-secondary"
                    disabled={!ruleTargetReady || !ruleInstructions.trim()}
                    type="submit"
                  >
                    Add rule
                  </button>
                </FormActions>
              </form>
              <div className="mt-4">
                {selectedStatus.rules.length > 0 ? (
                  <RowList label="Contact rules">
                    {selectedStatus.rules.map((rule) => (
                      <Row
                        key={rule.id}
                        subtitle={
                          <span className="line-clamp-2">{rule.instructions}</span>
                        }
                        title={describeRule(rule, channels, projects, agents)}
                        trailing={
                          <button
                            className="admin-button admin-button-secondary"
                            onClick={() =>
                              deleteRule.mutate({ ruleId: rule.id, statusId: selectedStatus.id })}
                            type="button"
                          >
                            Remove
                          </button>
                        }
                      />
                    ))}
                  </RowList>
                ) : (
                  <EmptyState>No contact rules yet — the response agent uses its default instructions.</EmptyState>
                )}
              </div>
            </Card>
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
