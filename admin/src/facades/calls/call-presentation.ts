import { ApiClientError } from '@nessie/client-core'
import type { PushQuietHours } from '@nessie/schemas'
import type { CallRecord } from '../../lib/api-client'

export type CallProvider = CallRecord['provider']

export const callProviderLabel = (provider: CallProvider): string => {
  switch (provider) {
    case 'google_meet':
      return 'Google Meet'
    case 'jitsi':
    case 'jitsi_embedded':
      return 'Jitsi'
    case 'microsoft_teams':
      return 'Microsoft Teams'
  }
}

export type StartCallFailure = {
  connection: 'google' | 'microsoft' | null
  message: string
}

export const presentStartCallFailure = (code: string | undefined): StartCallFailure => {
  switch (code) {
    case 'GOOGLE_NOT_CONNECTED':
      return { connection: 'google', message: 'Connect Google before starting a Google Meet call.' }
    case 'MEET_SCOPE_MISSING':
      return {
        connection: 'google',
        message: 'Reconnect Google to allow Nessie to create Google Meet links.',
      }
    case 'GOOGLE_REAUTH_REQUIRED':
      return { connection: 'google', message: 'Reconnect Google before starting this call.' }
    case 'MICROSOFT_NOT_CONNECTED':
      return {
        connection: 'microsoft',
        message: 'Connect Microsoft before starting a Microsoft Teams call.',
      }
    case 'ACTIVE_CALL_EXISTS':
      return { connection: null, message: 'A call is already happening in this channel.' }
    default:
      return { connection: null, message: 'Unable to start a call right now. Try again.' }
  }
}

/** Extracts the server's stable start failure code without matching its prose. */
export const startCallFailureCode = (error: unknown): string | undefined =>
  error instanceof ApiClientError ? error.code : undefined

export type AcceptResponsePresentation = 'open' | 'missed' | 'retry'

export const mapAcceptResponse = (code: string | undefined): AcceptResponsePresentation => {
  if (code === undefined || code === 'CALL_ALREADY_ACCEPTED') return 'open'
  if (code === 'CALL_NO_LONGER_RINGING') return 'missed'
  return 'retry'
}

const minutesSinceMidnight = (value: string): number => {
  const [hours = 0, minutes = 0] = value.split(':').map(Number)
  return hours * 60 + minutes
}

/** Evaluates the saved quiet-hour window in its own IANA timezone. */
export const isWithinCallQuietHours = (quietHours: PushQuietHours, now: Date): boolean => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    timeZone: quietHours.timezone,
  }).formatToParts(now)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false

  const current = hour * 60 + minute
  const start = minutesSinceMidnight(quietHours.start)
  const end = minutesSinceMidnight(quietHours.end)
  return start <= end ? current >= start && current < end : current >= start || current < end
}
