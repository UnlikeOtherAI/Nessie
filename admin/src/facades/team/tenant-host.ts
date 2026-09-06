import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { tenantHostKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * Resolving the hostname the browser is on to the tenant it means.
 *
 * `<org>.<base>` is an organisation's portal; `<team>.<org>.<base>` is a team.
 * Anything else — `app.nessie.works`, localhost, a deployment with no tenant
 * base domain configured — resolves to `null` and the app behaves exactly as it
 * always has.
 *
 * `useTenantHost` needs no session: the branded landing page has to render for
 * somebody not signed in yet, which is the entire point of it. That endpoint
 * answers about the ORGANISATION only and has no access to a team id, so it
 * cannot leak one.
 *
 * `useTenantTeam` is the authenticated other half — the ids behind a team
 * hostname, fetched only when there is a session to switch. Resolving is still
 * not authorization: the switch that follows re-checks live membership.
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
      /** `organisation` is a tenant's portal; `team` is a team inside one. */
      kind: 'organisation' | 'team'
      organisation: TenantOrganisation
      /**
       * The product's canonical origin, where sign-in happens. A tenant host is
       * never a registered OAuth redirect target — UOA matches redirect URLs
       * byte-for-byte and tenant hostnames are made at runtime — so a
       * signed-out visitor is handed off there and returned here.
       */
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

/** The ids behind a team hostname. Requires a session; null without one. */
export const useTenantTeam = (enabled: boolean) => {
  const apiClient = useApiClient()
  const hostname = typeof window === 'undefined' ? '' : window.location.hostname

  return useQuery({
    queryKey: tenantHostKeys.team(hostname),
    enabled: enabled && couldBeTenantHost(hostname),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: () =>
      apiClient.get<{ team: TenantTeam | null }>(
        `/api/hosts/team?host=${encodeURIComponent(hostname)}`,
      ),
  })
}

/**
 * Where a team lives, as a URL, or null.
 *
 * Null covers every case a caller should treat identically: this deployment
 * does not route tenants by hostname, UOA could not be reached, or the team has
 * no address. Callers navigate when they get one and stay put when they do not,
 * so host mode being off is not a special case they have to know about.
 */
export const fetchTeamHostUrl = async (
  apiClient: { get: <T>(path: string) => Promise<T> },
  teamId: string,
): Promise<string | null> => {
  try {
    const { url } = await apiClient.get<{ url: string | null }>(
      `/api/hosts/address?teamId=${encodeURIComponent(teamId)}`,
    )
    return url ?? null
  } catch {
    return null
  }
}

