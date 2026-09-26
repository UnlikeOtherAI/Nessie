import { useMemo } from 'react'

import { MembersRosterPanel } from '../../components/features/settings/MembersRosterPanel'
import { AdminScopeNotice } from '../../components/features/settings/AdminScopeNotice'
import { useAdminScope } from '../../components/features/settings/useAdminScope'
import { Notice } from '../../components/primitives/Notice'
import { SettingsPanel, type SettingsTabHostProps } from '../../components/shared/SettingsPanel'
import { useIsOwner } from '../../facades/auth/hooks'
import { useCurrentOrganization } from '../../facades/organization/hooks'
import { useTeams } from '../../facades/projects/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { OrganizationAdministrationGate } from '../settings/OrganizationAdministrationGate'
import { LocalOrganizationRoster } from './LocalOrganizationRoster'
import { LocalTeamRoster } from './LocalTeamRoster'
import { peopleScopeOptions } from './scope-entitlements'

// A different scope is a different roster: its status strip, its page and the
// rule a health alert pointed at mean nothing there, so a scope change clears
// them in the same replace.
const SCOPE_OWNED_PARAMS = ['tab', 'cursor', 'direction', 'page', 'automaticMembershipRule'] as const

/**
 * Admin › People: one roster behind the Organisation pages' scope switch — the
 * organisation, for the people who administer it, and each team the viewer is
 * in. Any member on an UnlikeOtherAI session reads their own teams' rosters, as
 * they always have; the organisation is shown to everybody else disabled, with
 * who may open it, and nothing narrows the list to the team the session
 * happens to be in without the address saying so.
 *
 * A team's roster is read through `GET /api/team/members`, which answers for
 * the team the person is working in and no other. A team the viewer is in but
 * not working in therefore says so, and how to get there, rather than
 * silently showing the current team's people under another team's name.
 */
export const PeoplePage = () => {
  const { me } = useAuthSession()
  const isOwner = useIsOwner()
  const organization = useCurrentOrganization()
  const teams = useTeams()
  const isUoaSession = me?.auth.providerType === 'uoa'
  // The organisation's roster is UOA's to answer on an SSO session, and the
  // local install's is the owner's to manage.
  const canSeeOrganization = isUoaSession
    ? organization.data?.administration.status === 'allowed'
    : isOwner
  const settled = teams.isFetched && (!isUoaSession || organization.isFetched)

  const options = useMemo(
    () => (settled && teams.data ? peopleScopeOptions({ canSeeOrganization }, teams.data) : null),
    [canSeeOrganization, settled, teams.data],
  )
  const { resolution, strip } = useAdminScope({
    ariaLabel: 'Whose people',
    clears: SCOPE_OWNED_PARAMS,
    failed: teams.isError,
    options,
    // With no scope in the address, somebody who does not administer the
    // organisation lands on the team they are working in — the one team whose
    // roster the server will read for them — and the address then names it.
    preferredTeamId: me?.context.teamId ?? null,
  })
  const host: SettingsTabHostProps = { eyebrow: 'Organisation', tabs: strip, title: 'People' }

  if (!me) return null

  if (resolution.status !== 'ready') {
    return (
      <AdminScopeNotice
        host={host}
        refusal="You are not in a team yet, so there is no roster to show."
        resolution={resolution}
        title="People"
      />
    )
  }

  const { option, scope } = resolution
  if (scope.kind === 'organisation') {
    return isUoaSession ? (
      <OrganizationAdministrationGate host={host}>
        <MembersRosterPanel host={host} scope="organization" />
      </OrganizationAdministrationGate>
    ) : (
      <LocalOrganizationRoster host={host} />
    )
  }

  if (scope.teamId !== me.context.teamId) {
    return (
      <SettingsPanel eyebrow="Organisation" host={host} title="People">
        <Notice tone="info">
          {`${option.label}’s people are listed while you are working in ${option.label}. Switch to `
            + 'it from the team menu, then come back here.'}
        </Notice>
      </SettingsPanel>
    )
  }

  return isUoaSession
    ? <MembersRosterPanel host={host} scope="team" />
    : <LocalTeamRoster host={host} />
}
