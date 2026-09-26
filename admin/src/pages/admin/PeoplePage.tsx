import { useMemo } from 'react'

import { MembersRosterPanel } from '../../components/features/settings/MembersRosterPanel'
import { Notice } from '../../components/primitives/Notice'
import { TabBar } from '../../components/primitives/TabBar'
import { SettingsPanel, type SettingsTabHostProps } from '../../components/shared/SettingsPanel'
import { useIsOwner } from '../../facades/auth/hooks'
import { useCurrentOrganization } from '../../facades/organization/hooks'
import { useTeams } from '../../facades/projects/hooks'
import { useTabParam } from '../../navigation/useTabParam'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { OrganizationAdministrationGate } from '../settings/OrganizationAdministrationGate'
import { LocalOrganizationRoster } from './LocalOrganizationRoster'
import { LocalTeamRoster } from './LocalTeamRoster'

const ORGANIZATION_SCOPE = 'organisation'
const TEAM_SCOPE_PREFIX = 'team:'

// A different scope is a different roster: its status strip, its page and the
// rule a health alert pointed at mean nothing there, so a scope change clears
// them in the same replace.
const SCOPE_OWNED_PARAMS = ['tab', 'cursor', 'direction', 'page', 'automaticMembershipRule']

/**
 * Admin › People: one roster behind a scope switch — the organisation, for the
 * people who administer it, and each team the viewer is in. Any member on an
 * UnlikeOtherAI session reads their own teams' rosters, as they always have;
 * nobody sees a scope they are not entitled to, and nothing narrows the list
 * to the team the session happens to be in.
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

  const options = useMemo(() => [
    ...(canSeeOrganization ? [{ label: 'Organisation', value: ORGANIZATION_SCOPE }] : []),
    ...(teams.data ?? [])
      .filter((team) => team.viewerIsMember)
      .map((team) => ({ label: team.name, value: `${TEAM_SCOPE_PREFIX}${team.id}` })),
  ], [canSeeOrganization, teams.data])
  const values = useMemo(() => options.map((option) => option.value), [options])

  // With no scope in the address: the organisation for somebody who
  // administers it, otherwise the team they are working in — the one team
  // whose roster the server will read for them.
  const workingTeamScope = `${TEAM_SCOPE_PREFIX}${me?.context.teamId ?? ''}`
  const fallback = canSeeOrganization
    ? ORGANIZATION_SCOPE
    : values.includes(workingTeamScope) ? workingTeamScope : values[0] ?? ORGANIZATION_SCOPE
  const [scope, selectScope] = useTabParam('scope', values, fallback, {
    clears: SCOPE_OWNED_PARAMS,
  })

  const host: SettingsTabHostProps = {
    eyebrow: 'Organisation',
    tabs: options.length > 1 ? (
      <TabBar
        ariaLabel="Whose people"
        items={options}
        onChange={selectScope}
        value={scope}
      />
    ) : undefined,
    title: 'People',
  }

  if (!me) return null

  const settled = teams.isFetched && (!isUoaSession || organization.isFetched)
  if (!settled || options.length === 0) {
    return (
      <SettingsPanel eyebrow="Organisation" host={host} title="People">
        <p className="text-sm text-[color:var(--tx3)]">
          {settled ? 'You are not in a team yet, so there is no roster to show.' : 'Loading people…'}
        </p>
      </SettingsPanel>
    )
  }

  if (scope === ORGANIZATION_SCOPE) {
    return isUoaSession ? (
      <OrganizationAdministrationGate host={host}>
        <MembersRosterPanel host={host} scope="organization" />
      </OrganizationAdministrationGate>
    ) : (
      <LocalOrganizationRoster host={host} />
    )
  }

  const teamId = scope.slice(TEAM_SCOPE_PREFIX.length)
  if (teamId !== me.context.teamId) {
    const teamName = options.find((option) => option.value === scope)?.label ?? 'This team'
    return (
      <SettingsPanel eyebrow="Organisation" host={host} title="People">
        <Notice tone="info">
          {`${teamName}’s people are listed while you are working in ${teamName}. Switch to it `
            + 'from the team menu, then come back here.'}
        </Notice>
      </SettingsPanel>
    )
  }

  return isUoaSession
    ? <MembersRosterPanel host={host} scope="team" />
    : <LocalTeamRoster host={host} />
}
