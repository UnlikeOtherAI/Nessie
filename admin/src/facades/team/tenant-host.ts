import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { tenantHostKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * Resolving the hostname the browser is on to the tenant it means.
 *
 * `<org>.<base>` is an organisation's portal; `<team>.<org>.<base>` is a team.
 * Anything else — `app.nessie.works`, localhost, a deployment with no tenant
 * base domain configured — resolves to `null` and the app behaves exactly as it
 * always has.
 *
 * The request is deliberately made without requiring a session: the branded
 * landing page has to render for somebody who is not signed in yet, which is
 * the entire point of it. The server answers an anonymous caller with the
 * organisation's public name and mark only — never the ids that would let a
 * client switch into a team.
 */

export type TenantOrganisation = {
  externalOrgId: string
  name: string
  slug: string
  iconUrl: string | null
}

export type TenantTeam = {
  externalOrgId: string
  externalTeamId: string
}

export type TenantHost =
  | { kind: null }
  | {
      kind: 'organisation'
      organisation: TenantOrganisation
      /**
       * The product's canonical origin, where sign-in happens. A tenant host is
       * never a registered OAuth redirect target — UOA matches redirect URLs
       * byte-for-byte and tenant hostnames are made at runtime — so a
       * signed-out visitor is handed off there and returned here.
       */
      signInOrigin: string | null
    }
  | {
      kind: 'team'
      organisation: TenantOrganisation
      /** Null for an anonymous caller: branding is public, ids are not. */
      team: TenantTeam | null
      signInOrigin: string | null
    }

/**
 * A hostname that could not possibly be a tenant host.
 *
 * A tenant host is at least `<something>.<base domain>`, and a base domain is
 * itself at least two labels — so anything with fewer than two labels, a bare
 * IP, or `localhost` is out. This is a cheap negative filter that keeps local
 * development and the end-to-end suites from making a request that can only
 * ever answer "no"; the server still decides, against its configured base
 * domain, for everything that gets past it.
 */
const couldBeTenantHost = (hostname: string): boolean => {
  if (!hostname || hostname === 'localhost') return false
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.startsWith('[')) return false
  return hostname.split('.').filter(Boolean).length >= 2
}

export const useTenantHost = () => {
  const apiClient = useApiClient()
  const hostname = typeof window === 'undefined' ? '' : window.location.hostname
  const enabled = couldBeTenantHost(hostname)

  return useQuery({
    queryKey: tenantHostKeys.resolve(hostname),
    enabled,
    // The answer cannot change while the page is open — the hostname is fixed
    // for the document — so never refetch it.
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: () =>
      apiClient.get<TenantHost>(`/api/hosts/resolve?host=${encodeURIComponent(hostname)}`),
  })
}
