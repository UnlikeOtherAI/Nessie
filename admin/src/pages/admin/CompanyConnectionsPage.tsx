import { useMemo } from 'react'

import { LockedAppsList } from '../../components/features/apps/LockedAppsList'
import { CloudBrowserPanel } from '../../components/features/browser-cloud/CloudBrowserPanel'
import { MailboxConnectionsPanel } from '../../components/features/mailbox-connections/MailboxConnectionsPanel'
import { AdminScopeNotice } from '../../components/features/settings/AdminScopeNotice'
import { useAdminScope } from '../../components/features/settings/useAdminScope'
import { SettingsPanel, type SettingsTabHostProps } from '../../components/shared/SettingsPanel'
import { useIsOrganizationAdmin, useIsOwner } from '../../facades/auth/hooks'
import { useTeams } from '../../facades/projects/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { connectionScopeOptions } from './scope-entitlements'

/**
 * The organisation's own side: its cloud browser account and the apps it has
 * locked. The account itself is the owner's to connect, which the panel shows
 * an admin greyed and saying so; its lock and home page are theirs to set.
 */
const OrganisationConnections = () => (
  <div className="grid gap-6">
    <CloudBrowserPanel scope="organization" />
    <LockedAppsList />
  </div>
)

/**
 * Company connections: what the company has signed in to on its agents'
 * behalf, at the organisation and at each team — one page with a scope switch.
 * Named apart from Apps on purpose: an app is a capability from the catalogue,
 * and this is what the company has connected.
 *
 * A team's scope holds its shared mailboxes and its cloud browser account; the
 * organisation's holds the company account and the apps locked for everyone.
 * Where each team's calls are hosted is that team's own setting, on its page
 * under Teams.
 */
export const CompanyConnectionsPage = () => {
  const { me } = useAuthSession()
  const isOwner = useIsOwner()
  const isOrganizationAdmin = useIsOrganizationAdmin()
  const teams = useTeams()
  const options = useMemo(
    () => (teams.data ? connectionScopeOptions({ isOrganizationAdmin, isOwner }, teams.data) : null),
    [isOrganizationAdmin, isOwner, teams.data],
  )
  const { resolution, strip } = useAdminScope({
    ariaLabel: 'Whose connections',
    failed: teams.isError,
    options,
    preferredTeamId: me?.context.teamId ?? null,
  })
  const host: SettingsTabHostProps = {
    eyebrow: 'Organisation',
    tabs: strip,
    title: 'Company connections',
  }

  if (resolution.status !== 'ready') {
    return (
      <AdminScopeNotice
        host={host}
        refusal="Only organisation owners and admins manage company connections."
        resolution={resolution}
        title="Company connections"
      />
    )
  }

  const { option, scope } = resolution
  return (
    <SettingsPanel eyebrow="Organisation" host={host} key={option.value} title="Company connections">
      {scope.kind === 'team' ? (
        <div className="grid gap-4">
          <MailboxConnectionsPanel scope="team" teamId={scope.teamId} />
          <CloudBrowserPanel scope="team" teamId={scope.teamId} />
        </div>
      ) : (
        <OrganisationConnections />
      )}
    </SettingsPanel>
  )
}
