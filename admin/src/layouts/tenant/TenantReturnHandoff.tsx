import { useEffect } from 'react'

import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import {
  forgetTenantReturn,
  parseTenantReturn,
  readTenantReturn,
  rememberTenantReturn,
  TENANT_RETURN_PARAM,
} from '../../lib/tenant-return'

/**
 * The two ends of the tenant sign-in round trip. Renders nothing.
 *
 * It sits above the router on purpose. Sign-in does not finish on one screen:
 * the provider comes back to `/login`, which forwards to `/login/completing`,
 * and a session can also arrive from a desktop or mobile import. Putting the
 * handoff on any one of those screens would work for one path and quietly not
 * for the others, so it lives where every path is underneath it.
 *
 * **Arriving** — a `?return=` on any URL is checked for shape and then against
 * `/api/hosts/resolve`, which answers only for real tenants of this
 * deployment, and only then kept. It is deliberately NOT stripped from the
 * address bar here: the router owns the address, this sits above it, and a
 * bare `history.replaceState` would leave the navigation ledger holding a
 * location it never saw. Leaving it costs nothing — reading it again is
 * idempotent, a rejected one stays rejected, and the OAuth round trip replaces
 * the query with the provider's own regardless.
 *
 * **Leaving** — once the session is authenticated, a kept address is consumed
 * once and navigated to. `window.location.assign` rather than the router,
 * because this is a different origin.
 */
export const TenantReturnHandoff = () => {
  const apiClient = useApiClient()
  const { sessionState } = useAuthSession()

  useEffect(() => {
    const raw = new URL(window.location.href).searchParams.get(TENANT_RETURN_PARAM)
    if (raw === null) return undefined

    const candidate = parseTenantReturn(raw, window.location.origin)
    if (!candidate) return undefined

    let abandoned = false
    void apiClient
      .get<{ kind: string | null }>(
        `/api/hosts/resolve?host=${encodeURIComponent(candidate.hostname)}`,
      )
      .then((answer) => {
        // A hostname this deployment does not serve is simply dropped. It is
        // not an error worth showing anybody — they still get signed in.
        if (abandoned || !answer?.kind) return
        rememberTenantReturn(candidate.href)
      })
      .catch(() => undefined)

    return () => {
      abandoned = true
    }
  }, [apiClient])

  useEffect(() => {
    if (sessionState !== 'authenticated') return
    const target = readTenantReturn()
    if (!target) return
    // Consume it first: if the navigation is interrupted, a stale address must
    // not hijack the next sign-in in this tab.
    forgetTenantReturn()
    window.location.assign(target)
  }, [sessionState])

  return null
}
