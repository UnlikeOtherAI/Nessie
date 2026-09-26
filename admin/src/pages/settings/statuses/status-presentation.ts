import type {
  AgentRecord,
  ChannelRecord,
  ProjectRecord,
  UserStatusRuleRecord,
  UserStatusScheduleRecord,
} from '../../../lib/api-client'
import i18n from '../../../i18n/i18n'

/** How a status's schedules and rules are read back to the person. */

export const dayLabels = (locale = i18n.resolvedLanguage ?? 'en-GB') =>
  Array.from({ length: 7 }, (_, day) => new Intl.DateTimeFormat(locale, { weekday: 'long' })
    .format(new Date(Date.UTC(2024, 0, 7 + day))))

export const toIsoFromLocal = (value: string) =>
  value ? new Date(value).toISOString() : null

const findLabel = (
  id: string | null,
  records: Array<{ id: string; label?: string; name?: string }>,
) => {
  if (!id) return i18n.t('statuses.anyContact', { ns: 'settings' })
  const record = records.find((entry) => entry.id === id)
  return record?.label ?? record?.name ?? i18n.t('statuses.unknown', { ns: 'settings' })
}

export const describeSchedule = (schedule: UserStatusScheduleRecord, locale?: string) => {
  const words = {
    dateRange: i18n.t('statuses.dateRangeBetween', { ns: 'settings' }),
    weekly: i18n.t('statuses.weekly', { ns: 'settings' }),
  }
  const format = (value: string | null | undefined) =>
    value ? new Date(value).toLocaleString(locale) : ''
  if (schedule.kind === 'date_range') {
    return `${format(schedule.startsAt)} ${words.dateRange} ${format(schedule.endsAt)}`
  }
  const day = dayLabels(locale)[schedule.dayOfWeek ?? 0]
  return i18n.t('statuses.weeklyScheduleDescription', {
    ns: 'settings', day, start: schedule.startTime, end: schedule.endTime, timezone: schedule.timezone,
  })
}

export const describeRule = (
  rule: UserStatusRuleRecord,
  channels: ChannelRecord[],
  projects: ProjectRecord[],
  agents: AgentRecord[],
  translate: (key: string) => string = (key) => i18n.t(key, { ns: 'settings' }),
) => {
  const scope =
    rule.scope === 'channel'
      ? `#${findLabel(rule.channelId, channels)}`
      : rule.scope === 'project'
        ? findLabel(rule.projectId, projects)
        : translate('statuses.everyone')
  const agent = rule.agentId ? findLabel(rule.agentId, agents) : translate('statuses.defaultAgent')
  return translate('statuses.ruleDescription').replace('{{scope}}', scope).replace('{{agent}}', agent)
}
