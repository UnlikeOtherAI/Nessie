import { Link } from 'react-router-dom'
import type {
  AgentRecord,
  ChannelRecord,
  ProjectRecord,
  UserStatusRecord,
  UserStatusRuleRecord,
  UserStatusScheduleRecord,
} from '../../../lib/api-client'
import { hoverCardClass } from '../settings-shared'

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

export const StatusList = ({
  activeId,
  statuses,
}: {
  activeId?: string
  statuses: UserStatusRecord[]
}) => (
  <div className="grid gap-2">
    {statuses.map((status) => (
      <Link
        key={status.id}
        className={[
          hoverCardClass,
          activeId === status.id ? 'border-[color:var(--accent)]' : '',
        ].join(' ')}
        to={`/settings/statuses/${status.id}`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-semibold text-[color:var(--tx)]">
              {status.emoji && <span aria-hidden>{status.emoji}</span>}
              <span className="truncate">{status.label}</span>
            </div>
            <div className="mt-1 text-xs text-[color:var(--tx3)]">
              {status.schedules.length} schedule{status.schedules.length === 1 ? '' : 's'} ·{' '}
              {status.rules.length} rule{status.rules.length === 1 ? '' : 's'}
            </div>
          </div>
          {status.activeNow && (
            <span className="rounded bg-[color:var(--success-soft)] px-2 py-1 text-xs text-[color:var(--success-text)]">
              Active
            </span>
          )}
        </div>
      </Link>
    ))}
  </div>
)
