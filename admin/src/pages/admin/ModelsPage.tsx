import { useMemo } from 'react'

import { ModelAvailabilitySettings } from '../../components/features/inference-models/ModelAvailabilitySettings'
import { AdminScopeNotice } from '../../components/features/settings/AdminScopeNotice'
import { useAdminScope } from '../../components/features/settings/useAdminScope'
import type { SettingsTabHostProps } from '../../components/shared/SettingsPanel'
import { useIsOrganizationAdmin, useIsOwner } from '../../facades/auth/hooks'
import { useTeams } from '../../facades/projects/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { modelScopeOptions } from './scope-entitlements'

// The catalogue's page belongs to the scope it was read at.
const CATALOGUE_PAGE_PARAMS = ['cursor', 'direction', 'page'] as const

/**
 * AI models: which of the deployment's models the organisation offers for new
 * selections, and how each team narrows that — one page with a scope switch
 * rather than a copy on every team's page. Each scope also carries its policy
 * for AI models on people's own computers.
 *
 * The organisation's catalogue is its owner's; a team's narrowing is any
 * owner's or admin's. So an admin lands on a team, with the organisation shown
 * disabled and why, instead of being refused after the page has loaded.
 */
export const ModelsPage = () => {
  const { me } = useAuthSession()
  const isOwner = useIsOwner()
  const isOrganizationAdmin = useIsOrganizationAdmin()
  const teams = useTeams()
  const options = useMemo(
    () => (teams.data ? modelScopeOptions({ isOrganizationAdmin, isOwner }, teams.data) : null),
    [isOrganizationAdmin, isOwner, teams.data],
  )
  const { resolution, strip } = useAdminScope({
    ariaLabel: 'Whose AI models',
    clears: CATALOGUE_PAGE_PARAMS,
    failed: teams.isError,
    options,
    preferredTeamId: me?.context.teamId ?? null,
  })
  const host: SettingsTabHostProps = { eyebrow: 'Organisation', tabs: strip, title: 'AI models' }

  if (resolution.status !== 'ready') {
    return (
      <AdminScopeNotice
        host={host}
        refusal="Only organisation owners and admins choose AI models."
        resolution={resolution}
        title="AI models"
      />
    )
  }

  const { option, scope } = resolution
  return (
    <ModelAvailabilitySettings
      host={host}
      // A scope is a different list: its test results, its pending switch and
      // its messages belong to the list they were made in.
      key={option.value}
      {...(scope.kind === 'team' ? { teamId: scope.teamId } : {})}
      {...(isOwner
        ? {}
        : { testUnavailableReason: 'Only the organisation owner sends a test, because a test spends credits.' })}
    />
  )
}
