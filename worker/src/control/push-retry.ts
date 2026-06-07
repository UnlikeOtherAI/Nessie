import type { PushResult } from '@nessie/push'

export type PushRetryProvider = 'apns' | 'fcm'

export const PUSH_MAX_SEND_ATTEMPTS = 3

export const defaultPushRetryDelayMs = (completedAttempt: number): number =>
  completedAttempt * 100

export const isTransientPushFailure = (
  provider: PushRetryProvider,
  result: PushResult,
): boolean => {
  if (result.ok || result.deadToken) {
    return false
  }

  if (provider === 'apns') {
    return result.status >= 500 && result.status < 600
  }

  if (result.status === 0 || (result.status >= 500 && result.status < 600)) {
    return true
  }

  return result.error?.trim().toUpperCase() === 'UNAVAILABLE'
}

export const shouldRetryPushFailure = (
  provider: PushRetryProvider,
  result: PushResult,
  completedAttempt: number,
): boolean =>
  completedAttempt < PUSH_MAX_SEND_ATTEMPTS
  && isTransientPushFailure(provider, result)
