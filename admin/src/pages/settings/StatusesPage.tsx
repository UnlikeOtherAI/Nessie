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
import { sectionTitleClass, SettingsPanel } from './settings-shared'
import {
  dayLabels,
  describeRule,
  describeSchedule,
  StatusList,
  toIsoFromLocal,
} from './statuses/status-components'

export const StatusesPage = () => {
  const { statusId } = useParams()
  const navigate = useNavigate()
  const { data: statuses = [] } = useStatuses()
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
    () => statuses.find((status) => status.id === statusId) ?? null,
    [statusId, statuses],
  )

  const [newLabel, setNewLabel] = useState('')
  const [newEmoji, setNewEmoji] = useState('')
  const [label, setLabel] = useState('')
  const [emoji, setEmoji] = useState('')
  const [agentEnabled, setAgentEnabled] = useState(false)
  const [agentInstructions, setAgentInstructions] = useState('')
  const [scheduleKind, setScheduleKind] = useState<UserStatusScheduleKind>('weekly')
  const [scheduleLabel, setScheduleLabel] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [dayOfWeek, setDayOfWeek] = useState(1)
  const [startTime, setStartTime] = useState('12:00')
  const [endTime, setEndTime] = useState('13:00')
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [ruleScope, setRuleScope] = useState<UserStatusRuleScope>('fallback')
  const [ruleChannelId, setRuleChannelId] = useState('')
  const [ruleProjectId, setRuleProjectId] = useState('')
  const [ruleAgentId, setRuleAgentId] = useState('')
  const [ruleAgentEnabled, setRuleAgentEnabled] = useState(true)
  const [ruleInstructions, setRuleInstructions] = useState('')

  useEffect(() => {
    if (!statusId && statuses[0]) {
      navigate(`/settings/statuses/${statuses[0].id}`, { replace: true })
    }
  }, [navigate, statusId, statuses])

  useEffect(() => {
    setLabel(selectedStatus?.label ?? '')
    setEmoji(selectedStatus?.emoji ?? '')
    setAgentEnabled(selectedStatus?.agentEnabled ?? false)
    setAgentInstructions(selectedStatus?.agentInstructions ?? '')
  }, [
    selectedStatus?.agentEnabled,
    selectedStatus?.agentInstructions,
    selectedStatus?.emoji,
    selectedStatus?.id,
    selectedStatus?.label,
  ])

  const createStatusSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!newLabel.trim()) return
    const created = await createStatus.mutateAsync({
      emoji: newEmoji.trim() || null,
      label: newLabel.trim(),
    })
    setNewLabel('')
    setNewEmoji('')
    navigate(`/settings/statuses/${created.id}`)
  }

  const saveStatusSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedStatus || !label.trim()) return
    await updateStatus.mutateAsync({
      agentEnabled,
      agentInstructions: agentInstructions.trim() || null,
      emoji: emoji.trim() || null,
      label: label.trim(),
      statusId: selectedStatus.id,
    })
  }

  const scheduleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedStatus) return
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
  }

  const ruleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedStatus || !ruleInstructions.trim()) return
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
  }

  const deleteSelectedStatus = async () => {
    if (!selectedStatus) return
    await deleteStatus.mutateAsync(selectedStatus.id)
    navigate('/settings/statuses', { replace: true })
  }

  const ruleTargetReady =
    ruleScope === 'fallback' ||
    (ruleScope === 'channel' && Boolean(ruleChannelId)) ||
    (ruleScope === 'project' && Boolean(ruleProjectId))

  return (
    <SettingsPanel
      eyebrow="General"
      title="Statuses"
      actions={
        <button
          className="admin-button admin-button-secondary"
          onClick={() => clearActiveStatus.mutate()}
          type="button"
        >
          Clear active
        </button>
      }
    >
      <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        <section className="admin-card p-4">
          <div className={sectionTitleClass}>Statuses</div>
          <form className="mt-4 grid gap-2" onSubmit={createStatusSubmit}>
            <div className="grid grid-cols-[70px_minmax(0,1fr)] gap-2">
              <input
                className="admin-input"
                onChange={(event) => setNewEmoji(event.target.value)}
                placeholder="Icon"
                value={newEmoji}
              />
              <input
                className="admin-input"
                onChange={(event) => setNewLabel(event.target.value)}
                placeholder="New status"
                value={newLabel}
              />
            </div>
            <button className="admin-button admin-button-primary" type="submit">
              Add status
            </button>
          </form>
          <div className="mt-4">
            {statuses.length > 0 ? (
              <StatusList activeId={selectedStatus?.id} statuses={statuses} />
            ) : (
              <div className="rounded border border-dashed border-[color:var(--sep)] p-4 text-sm text-[color:var(--tx3)]">
                No statuses yet.
              </div>
            )}
          </div>
        </section>

        {selectedStatus ? (
          <section className="grid gap-4">
            <form className="admin-card grid gap-4 p-4" onSubmit={saveStatusSubmit}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className={sectionTitleClass}>Status detail</div>
                  <div className="mt-2 text-sm text-[color:var(--tx3)]">
                    {selectedStatus.activeNow ? 'Currently visible' : 'Not currently visible'}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    className="admin-button admin-button-secondary"
                    onClick={() => activateStatus.mutate(selectedStatus.id)}
                    type="button"
                  >
                    Set active
                  </button>
                  <button
                    className="admin-button admin-button-secondary text-[color:var(--danger-text)]"
                    onClick={deleteSelectedStatus}
                    type="button"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-[90px_minmax(0,1fr)]">
                <input
                  className="admin-input"
                  onChange={(event) => setEmoji(event.target.value)}
                  placeholder="Icon"
                  value={emoji}
                />
                <input
                  className="admin-input"
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="Status label"
                  value={label}
                />
              </div>
              <div className="flex items-center justify-between gap-4 rounded border border-[color:var(--sep)] p-3">
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
              <textarea
                className="admin-input min-h-28 resize-y"
                onChange={(event) => setAgentInstructions(event.target.value)}
                placeholder="Agent instructions"
                value={agentInstructions}
              />
              <button className="admin-button admin-button-primary justify-self-start" type="submit">
                Save status
              </button>
            </form>

            <section className="admin-card p-4">
              <div className={sectionTitleClass}>Schedules</div>
              <form className="mt-4 grid gap-3" onSubmit={scheduleSubmit}>
                <div className="grid gap-2 md:grid-cols-3">
                  <select
                    className="admin-input"
                    onChange={(event) =>
                      setScheduleKind(event.target.value as UserStatusScheduleKind)
                    }
                    value={scheduleKind}
                  >
                    <option value="weekly">Weekly</option>
                    <option value="date_range">Date range</option>
                  </select>
                  <input
                    className="admin-input md:col-span-2"
                    onChange={(event) => setScheduleLabel(event.target.value)}
                    placeholder="Schedule label"
                    value={scheduleLabel}
                  />
                </div>
                {scheduleKind === 'date_range' ? (
                  <div className="grid gap-2 md:grid-cols-2">
                    <input
                      className="admin-input"
                      onChange={(event) => setStartsAt(event.target.value)}
                      type="datetime-local"
                      value={startsAt}
                    />
                    <input
                      className="admin-input"
                      onChange={(event) => setEndsAt(event.target.value)}
                      type="datetime-local"
                      value={endsAt}
                    />
                  </div>
                ) : (
                  <div className="grid gap-2 md:grid-cols-4">
                    <select
                      className="admin-input"
                      onChange={(event) => setDayOfWeek(Number(event.target.value))}
                      value={dayOfWeek}
                    >
                      {dayLabels.map((day, index) => (
                        <option key={day} value={index}>
                          {day}
                        </option>
                      ))}
                    </select>
                    <input
                      className="admin-input"
                      onChange={(event) => setStartTime(event.target.value)}
                      type="time"
                      value={startTime}
                    />
                    <input
                      className="admin-input"
                      onChange={(event) => setEndTime(event.target.value)}
                      type="time"
                      value={endTime}
                    />
                    <input
                      className="admin-input"
                      onChange={(event) => setTimezone(event.target.value)}
                      value={timezone}
                    />
                  </div>
                )}
                <button className="admin-button admin-button-secondary justify-self-start" type="submit">
                  Add schedule
                </button>
              </form>
              <div className="mt-4 grid gap-2">
                {selectedStatus.schedules.map((schedule) => (
                  <div
                    key={schedule.id}
                    className="flex items-center justify-between gap-3 rounded border border-[color:var(--sep)] p-3"
                  >
                    <div>
                      <div className="font-semibold text-[color:var(--tx)]">
                        {schedule.label || (schedule.kind === 'weekly' ? 'Weekly' : 'Date range')}
                      </div>
                      <div className="text-sm text-[color:var(--tx3)]">
                        {describeSchedule(schedule)}
                      </div>
                    </div>
                    <button
                      className="admin-button admin-button-secondary"
                      onClick={() =>
                        deleteSchedule.mutate({
                          scheduleId: schedule.id,
                          statusId: selectedStatus.id,
                        })
                      }
                      type="button"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <section className="admin-card p-4">
              <div className={sectionTitleClass}>Contact rules</div>
              <form className="mt-4 grid gap-3" onSubmit={ruleSubmit}>
                <div className="grid gap-2 md:grid-cols-3">
                  <select
                    className="admin-input"
                    onChange={(event) => setRuleScope(event.target.value as UserStatusRuleScope)}
                    value={ruleScope}
                  >
                    <option value="fallback">Everyone</option>
                    <option value="channel">Channel</option>
                    <option value="project">Project</option>
                  </select>
                  {ruleScope === 'channel' && (
                    <select
                      className="admin-input md:col-span-2"
                      onChange={(event) => setRuleChannelId(event.target.value)}
                      value={ruleChannelId}
                    >
                      <option value="">Select channel</option>
                      {channels.map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          {channel.label}
                        </option>
                      ))}
                    </select>
                  )}
                  {ruleScope === 'project' && (
                    <select
                      className="admin-input md:col-span-2"
                      onChange={(event) => setRuleProjectId(event.target.value)}
                      value={ruleProjectId}
                    >
                      <option value="">Select project</option>
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
                  <select
                    className="admin-input"
                    onChange={(event) => setRuleAgentId(event.target.value)}
                    value={ruleAgentId}
                  >
                    <option value="">Default status agent</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                  <div className="flex items-center justify-between gap-3 rounded border border-[color:var(--sep)] px-3">
                    <span className="text-sm text-[color:var(--tx2)]">Agent</span>
                    <Switch
                      checked={ruleAgentEnabled}
                      label="Enable rule agent"
                      onChange={setRuleAgentEnabled}
                    />
                  </div>
                </div>
                <textarea
                  className="admin-input min-h-24 resize-y"
                  onChange={(event) => setRuleInstructions(event.target.value)}
                  placeholder="Rule-specific instructions"
                  value={ruleInstructions}
                />
                <button
                  className="admin-button admin-button-secondary justify-self-start"
                  disabled={!ruleTargetReady || !ruleInstructions.trim()}
                  type="submit"
                >
                  Add rule
                </button>
              </form>
              <div className="mt-4 grid gap-2">
                {selectedStatus.rules.map((rule) => (
                  <div
                    key={rule.id}
                    className="flex items-start justify-between gap-3 rounded border border-[color:var(--sep)] p-3"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-[color:var(--tx)]">
                        {describeRule(rule, channels, projects, agents)}
                      </div>
                      <div className="mt-1 line-clamp-2 text-sm text-[color:var(--tx3)]">
                        {rule.instructions}
                      </div>
                    </div>
                    <button
                      className="admin-button admin-button-secondary"
                      onClick={() =>
                        deleteRule.mutate({ ruleId: rule.id, statusId: selectedStatus.id })
                      }
                      type="button"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </section>
          </section>
        ) : (
          <section className="admin-card p-4 text-sm text-[color:var(--tx3)]">
            Create or select a status to edit schedules and contact rules.
          </section>
        )}
      </div>
    </SettingsPanel>
  )
}
