import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'

import { fetchTeamHostUrl, useTenantHost } from './tenant-host'
import {
  isNativeShell,
  resolveTeamSwitchDestination,
  TEAM_LANDING_PATH,
} from '../../lib/tenant-navigation'
import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * Land in the team the session has just been switched onto.
 *
 * Every in-app switch ends the same way and used to end it three different
 * ways: the rail picker followed the team's address while accepting an
 * invitation and creating a team both called `navigate('/channels')` and
 * stayed wherever they were. On a tenant host that difference is the whole
 * defect — the URL keeps naming the previous team, and the next load of it
 * switches the session back — so all three go through
 * `lib/tenant-navigation.ts` now, and this hook is what makes that one line at
 * each call site.
 *
 * Call it AFTER the switch has resolved. The destination assumes the session
 * is already on the target team, which is what lets the canonical origin be a
 * complete answer for a team with no address of its own.
 *
 * `OrgPortal` deliberately does not use this: it has no router underneath it
 * (its own hostname renders the portal for every path) and it reads the
 * canonical origin from the props the host gate resolved, so it calls the
 * shared policy directly with `currentHostServesApp: false`.
 */
export const useTeamSwitchNavigation = (): ((teamId: string) => Promise<void>) => {
  const apiClient = useApiClient()
  const navigate = useNavigate()
  // Which hostname this is. A tenant host serves the app, but only for its own
  // team, so a switch to any other team has to leave it.
  const { data: tenantHost } = useTenantHost()

  return useCallback(async (teamId: string): Promise<void> => {
    const destination = await resolveTeamSwitchDestination({
      // Only meaningful on a tenant host — on the canonical origin the app is
      // already where it belongs and nothing needs an origin to leave for.
      canonicalOrigin: tenantHost?.kind ? tenantHost.signInOrigin : null,
      currentHost: window.location.host,
      currentHostIsTenant: Boolean(tenantHost?.kind),
      currentHostServesApp: true,
      fetchTeamUrl: () => fetchTeamHostUrl(apiClient, teamId),
      inNativeShell: isNativeShell(),
    })
    if (destination.kind === 'document') {
      window.location.assign(destination.href)
      return
    }
    void navigate(TEAM_LANDING_PATH, { replace: true })
  }, [apiClient, navigate, tenantHost])
}
