import { useEffect } from 'react'
import type { SessionCredentialSnapshot } from '../lib/imported-session-policy'
import type { AmbientRefreshGateHost } from './ambient-refresh-gate-host'

const RETRY_DELAYS_MS = [1_000, 2_500, 5_000, 10_000, 30_000] as const
const retryDelay = (attempt: number): number =>
  RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 30_000

type UseSessionRestorationInput = {
  ambientRefreshGate: AmbientRefreshGateHost
  readSessionCredential: () => SessionCredentialSnapshot
  refreshSessionFor: (expected: SessionCredentialSnapshot) => Promise<void>
}

/**
 * The two mount-time restores that keep a stored bearer signed in: the
 * startup fetch with its outage retry, and the re-fetch a back/forward-cache
 * revival needs. Both exist only to call `refreshSessionFor`, and neither
 * owns state — they are here rather than in `AuthSessionProvider` because
 * their lifetime rules (retry ladder, `online` listener, `pageshow`
 * persistence flag) are a subject of their own.
 */
export const useSessionRestoration = ({
  ambientRefreshGate,
  readSessionCredential,
  refreshSessionFor,
}: UseSessionRestorationInput): void => {
  useEffect(() => {
    // Safari can revive a document from its back/forward cache while its
    // startup /auth/me request was suspended during an external SSO launch.
    // Reconcile again when that document becomes live; otherwise the shell can
    // remain in its loading state forever with no request in flight.
    const reconcileReturnedDocument = (event: PageTransitionEvent): void => {
      if (!event.persisted) return
      void refreshSessionFor(readSessionCredential()).catch(() => undefined)
    }

    window.addEventListener('pageshow', reconcileReturnedDocument)
    return () => window.removeEventListener('pageshow', reconcileReturnedDocument)
  }, [readSessionCredential, refreshSessionFor])

  // A network outage, rate limit, or server error during restore is not a
  // logout. Keep the bearer token in localStorage and retry until the API is
  // reachable. An explicit refresh 401 resolves normally after clearSession,
  // so it does not enter this retry loop.
  useEffect(() => {
    const expected = readSessionCredential()
    let cancelled = false
    let restoring = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0

    const restoreSession = async (): Promise<void> => {
      if (cancelled || restoring || ambientRefreshGate.isBlocked()) return
      restoring = true
      try {
        await refreshSessionFor(expected)
        attempt = 0
      } catch {
        if (cancelled) return
        const delay = retryDelay(attempt)
        attempt += 1
        retryTimer = setTimeout(() => void restoreSession(), delay)
      } finally {
        restoring = false
      }
    }

    const retryWhenOnline = (): void => {
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      void restoreSession()
    }

    window.addEventListener('online', retryWhenOnline)
    void restoreSession()
    return () => {
      cancelled = true
      window.removeEventListener('online', retryWhenOnline)
      if (retryTimer) clearTimeout(retryTimer)
    }
    // `ambientRefreshGate` is a stable host for the life of the provider.
  }, [ambientRefreshGate, readSessionCredential, refreshSessionFor])
}
