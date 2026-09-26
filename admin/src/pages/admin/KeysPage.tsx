import { useMemo } from 'react'
import { Link } from 'react-router-dom'

import { AdminScopeNotice } from '../../components/features/settings/AdminScopeNotice'
import { useAdminScope } from '../../components/features/settings/useAdminScope'
import type { SettingsTabHostProps } from '../../components/shared/SettingsPanel'
import { useIsOrganizationAdmin, useIsOwner } from '../../facades/auth/hooks'
import { useTeams } from '../../facades/projects/hooks'
import { SecretsPanel } from '../settings/SecretsPanel'
import { keyScopeOptions } from './scope-entitlements'

/**
 * Keys: the organisation's credentials, which every team and person inherits,
 * and each team's own over them — one page with a scope switch, the same
 * `SecretsPanel` at either level. Saving or revoking a key above a person's own
 * is the owner's, so nobody else is offered a scope here; the keys that reach
 * them are on their own Saved keys page.
 */
export const KeysPage = () => {
  const isOwner = useIsOwner()
  const isOrganizationAdmin = useIsOrganizationAdmin()
  const teams = useTeams()
  const options = useMemo(
    () => (teams.data ? keyScopeOptions({ isOrganizationAdmin, isOwner }, teams.data) : null),
    [isOrganizationAdmin, isOwner, teams.data],
  )
  const { resolution, strip } = useAdminScope({
    ariaLabel: 'Whose keys',
    failed: teams.isError,
    options,
  })
  const host: SettingsTabHostProps = { eyebrow: 'Organisation', tabs: strip, title: 'Keys' }

  if (resolution.status !== 'ready') {
    return (
      <AdminScopeNotice
        host={host}
        refusal={(
          <p>
            Only the organisation owner manages the organisation’s and teams’ keys. The keys that
            reach you are in{' '}
            <Link className="text-[color:var(--lnk)] hover:underline" to="/settings/keys">
              Your settings › Saved keys
            </Link>
            .
          </p>
        )}
        resolution={resolution}
        title="Keys"
      />
    )
  }

  const { option, scope } = resolution
  return scope.kind === 'team' ? (
    <SecretsPanel host={host} key={option.value} scope="team" teamId={scope.teamId} />
  ) : (
    <SecretsPanel host={host} key={option.value} scope="organization" />
  )
}
