import { useEffect, useRef } from 'react'

import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import type { ProvisionedTeam } from './provisioning'

/**
 * Landing in the team whose hostname you opened.
 *
 * The admin bundle is one artifact served on every team host, so a cold load at
 * `design.acme.nessie.works` starts with a session pointing wherever it last
 * pointed. This asks the server which tenant the hostname means and runs the
 * ordinary team switch onto it — the same silent switch the team picker uses.
 *
 * Two things it deliberately is not:
 *
 * - **It is not authorization.** Resolving a name to ids grants nothing; the
 *   switch that follows is where membership is checked, and it fails closed for
 *   a hostname the person cannot open. A hostname is a request to look at a
 *   team, never a claim to be in it.
 * - **It is not a redirect loop.** It runs once per hostname per page load, so
 *   a failed switch leaves the person where they are rather than retrying
 *   forever against a team they cannot reach.
 */
export const useTeamHostSync = (): void => {
  const apiClient = useApiClient()
  const { switchUoaTeam, token } = useAuthSession()
  const attempted = useRef<string | null>(null)

  useEffect(() => {
    if (!token) return

    const host = window.location.hostname
    if (!host || attempted.current === host) return
    attempted.current = host

    void (async () => {
      try {
        const { team } = await apiClient.get<{ team: ProvisionedTeam | null }>(
          `/api/hosts/resolve?host=${encodeURIComponent(host)}`,
        )
        // Not a team host, or a tenant this deployment cannot see. Either way
        // the session already in hand is the right one.
        if (!team) return

        await switchUoaTeam({
          organizationId: team.externalOrgId,
          teamId: team.externalTeamId,
        })
      } catch {
        // A hostname that cannot be resolved or switched to must not strand
        // somebody on a blank screen: the app carries on in whichever team the
        // session already holds.
      }
    })()
  }, [apiClient, switchUoaTeam, token])
}
