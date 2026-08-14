import { useEffect } from 'react'
import {
  getAccessTokenExpiresAtMs,
  getAccessTokenRenewalDelayMs,
} from '@nessie/client-core'
import type { SessionCredentialSnapshot } from '../lib/imported-session-policy'
import type { StoredTokenMode } from '../lib/storage'

const ACCESS_TOKEN_RENEWAL_LEEWAY_MS = 120_000
const ACCESS_TOKEN_RENEWAL_RETRY_MS = 30_000
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647

/** Imported bearers expire in place; renewable sessions rotate before expiry. */
export const useAccessTokenRenewal = (input: {
  clearImportedSession: (expectedToken: string) => Promise<void>
  refreshAccessToken: (expected?: SessionCredentialSnapshot) => Promise<string | null>
  sessionMode: StoredTokenMode
  token: string | null
}): void => {
  useEffect(() => {
    if (!input.token) return
    const token = input.token
    const expected = { mode: input.sessionMode, token }
    let cancelled = false
    let renewalTimer: ReturnType<typeof setTimeout> | null = null

    const clearRenewalTimer = (): void => {
      if (renewalTimer) {
        clearTimeout(renewalTimer)
        renewalTimer = null
      }
    }

    if (input.sessionMode === 'imported') {
      const clearImportedWhenExpired = (): void => {
        clearRenewalTimer()
        const expiresAt = getAccessTokenExpiresAtMs(token)
        if (expiresAt === null) return
        const delay = expiresAt - Date.now()
        if (delay <= 0) {
          void input.clearImportedSession(token)
          return
        }
        renewalTimer = setTimeout(
          clearImportedWhenExpired,
          Math.min(delay, MAX_TIMEOUT_DELAY_MS),
        )
      }
      const clearImportedOnReturn = (): void => {
        if (document.visibilityState === 'visible') clearImportedWhenExpired()
      }

      clearImportedWhenExpired()
      window.addEventListener('focus', clearImportedOnReturn)
      document.addEventListener('visibilitychange', clearImportedOnReturn)
      return () => {
        clearRenewalTimer()
        window.removeEventListener('focus', clearImportedOnReturn)
        document.removeEventListener('visibilitychange', clearImportedOnReturn)
      }
    }

    const scheduleRenewal = (delayMs: number): void => {
      clearRenewalTimer()
      renewalTimer = setTimeout(() => {
        const remainingDelay = getAccessTokenRenewalDelayMs(
          token,
          Date.now(),
          ACCESS_TOKEN_RENEWAL_LEEWAY_MS,
        )
        if (remainingDelay === null) return
        if (remainingDelay > 0) {
          scheduleRenewal(remainingDelay)
          return
        }
        void renewAccessToken()
      }, Math.min(delayMs, MAX_TIMEOUT_DELAY_MS))
    }

    const renewAccessToken = async (): Promise<void> => {
      if (cancelled) return
      try {
        await input.refreshAccessToken(expected)
      } catch {
        if (!cancelled) scheduleRenewal(ACCESS_TOKEN_RENEWAL_RETRY_MS)
      }
    }

    const renewWhenDue = (): void => {
      if (document.visibilityState !== 'visible') return
      const delay = getAccessTokenRenewalDelayMs(
        token,
        Date.now(),
        ACCESS_TOKEN_RENEWAL_LEEWAY_MS,
      )
      if (delay === 0) {
        clearRenewalTimer()
        void renewAccessToken()
      }
    }

    const delay = getAccessTokenRenewalDelayMs(
      token,
      Date.now(),
      ACCESS_TOKEN_RENEWAL_LEEWAY_MS,
    )
    if (delay !== null) scheduleRenewal(delay)
    window.addEventListener('focus', renewWhenDue)
    document.addEventListener('visibilitychange', renewWhenDue)

    return () => {
      cancelled = true
      clearRenewalTimer()
      window.removeEventListener('focus', renewWhenDue)
      document.removeEventListener('visibilitychange', renewWhenDue)
    }
  }, [
    input.clearImportedSession,
    input.refreshAccessToken,
    input.sessionMode,
    input.token,
  ])
}
