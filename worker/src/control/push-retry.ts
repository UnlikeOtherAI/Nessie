import type { PushResult } from '@nessie/push'

/**
 * When one send to one endpoint may be attempted again. This is the *inner*
 * retry: `sendWithRetry` in `push-delivery-core.ts` runs it entirely inside a
 * single `push_send_claims` claim, and stops at the first non-retryable result
 * — which `isTransientPushFailure` makes include every success — so a retry can
 * never duplicate a delivery that already succeeded. The *outer* retry, a queue
 * redelivery of the whole job, is stopped by that same claim.
 */

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
