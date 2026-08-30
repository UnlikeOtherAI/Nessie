import {
  UserPreferencesSchema,
  type PushQuietHours,
} from '@nessie/schemas'

const parseTimeOfDayMinutes = (value: string): number => {
  const [hourPart, minutePart] = value.split(':')
  const hours = Number(hourPart)
  const minutes = Number(minutePart)
  return hours * 60 + minutes
}

const localMinutesInTimeZone = (now: Date, timezone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    timeZone: timezone,
  }).formatToParts(now)
  const values = new Map(parts.map((part) => [part.type, part.value]))
  const hour = Number(values.get('hour'))
  const minute = Number(values.get('minute'))
  return hour * 60 + minute
}

export const isWithinPushQuietHours = (
  quietHours: PushQuietHours,
  now: Date,
): boolean => {
  const startMinutes = parseTimeOfDayMinutes(quietHours.start)
  const endMinutes = parseTimeOfDayMinutes(quietHours.end)
  const currentMinutes = localMinutesInTimeZone(now, quietHours.timezone)

  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes
  }

  return currentMinutes >= startMinutes || currentMinutes < endMinutes
}

export const shouldSuppressPushForPreferences = (
  preferences: unknown,
  now: Date,
  kind: 'messages' | 'mentions' | 'budgetAlerts' | 'assignedWork' | 'publishedKnowledge',
): boolean => {
  const parsed = UserPreferencesSchema.safeParse(preferences ?? {})
  if (!parsed.success) {
    return false
  }

  if (parsed.data.pushEnabled === false) {
    return true
  }

  if (parsed.data.focusModeEnabled === true) {
    return true
  }

  const enabledForKind = {
    budgetAlerts: parsed.data.pushBudgetAlerts,
    assignedWork: parsed.data.pushAssignedWork,
    mentions: parsed.data.pushMentions,
    messages: parsed.data.pushMessages,
    publishedKnowledge: parsed.data.pushPublishedKnowledge,
  }[kind]
  if (enabledForKind === false) {
    return true
  }

  return parsed.data.pushQuietHours
    ? isWithinPushQuietHours(parsed.data.pushQuietHours, now)
    : false
}
