import type { UserStatusSchedule } from '@prisma/client'

const localTimeParts = (date: Date, timezone: string): { day: number; minutes: number } => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    timeZone: timezone,
    weekday: 'short',
  }).formatToParts(date)
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Sun'
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0') % 24
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0')
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday)
  return { day: day < 0 ? 0 : day, minutes: hour * 60 + minute }
}

const timeToMinutes = (value: string): number => {
  const [hour = '0', minute = '0'] = value.split(':')
  return Number(hour) * 60 + Number(minute)
}

export const isScheduleActive = (
  schedule: UserStatusSchedule,
  now = new Date(),
): boolean => {
  if (!schedule.enabled) return false
  if (schedule.kind === 'date_range') {
    return Boolean(
      schedule.startsAt &&
        schedule.endsAt &&
        now >= schedule.startsAt &&
        now <= schedule.endsAt,
    )
  }
  if (
    schedule.dayOfWeek === null ||
    schedule.startTime === null ||
    schedule.endTime === null
  ) {
    return false
  }
  const current = localTimeParts(now, schedule.timezone)
  const start = timeToMinutes(schedule.startTime)
  const end = timeToMinutes(schedule.endTime)
  const previousDay = (schedule.dayOfWeek + 1) % 7 === current.day
  if (start <= end) {
    return (
      current.day === schedule.dayOfWeek &&
      current.minutes >= start &&
      current.minutes <= end
    )
  }
  return (
    (current.day === schedule.dayOfWeek && current.minutes >= start) ||
    (previousDay && current.minutes <= end)
  )
}
