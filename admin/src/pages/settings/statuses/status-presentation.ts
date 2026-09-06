import type {
  AgentRecord,
  ChannelRecord,
  ProjectRecord,
  UserStatusRuleRecord,
  UserStatusScheduleRecord,
} from '../../../lib/api-client'

/** How a status's schedules and rules are read back to the person. */

export const dayLabels = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

export const toIsoFromLocal = (value: string) =>
  value ? new Date(value).toISOString() : null

const findLabel = (
  id: string | null,
  records: Array<{ id: string; label?: string; name?: string }>,
) => {
  if (!id) return 'Any contact'
  const record = records.find((entry) => entry.id === id)
  return record?.label ?? record?.name ?? 'Unknown'
}

export const describeSchedule = (schedule: UserStatusScheduleRecord) => {
  if (schedule.kind === 'date_range') {
    return `${new Date(schedule.startsAt ?? '').toLocaleString()} to ${new Date(
      schedule.endsAt ?? '',
    ).toLocaleString()}`
  }
  const day = dayLabels[schedule.dayOfWeek ?? 0]
  return `${day}, ${schedule.startTime} to ${schedule.endTime} (${schedule.timezone})`
}

export const describeRule = (
  rule: UserStatusRuleRecord,
  channels: ChannelRecord[],
  projects: ProjectRecord[],
  agents: AgentRecord[],
) => {
  const scope =
    rule.scope === 'channel'
      ? `#${findLabel(rule.channelId, channels)}`
      : rule.scope === 'project'
        ? findLabel(rule.projectId, projects)
        : 'Everyone'
  const agent = rule.agentId ? findLabel(rule.agentId, agents) : 'Default status agent'
  return `${scope} -> ${agent}`
}
