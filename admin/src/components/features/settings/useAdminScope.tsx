import { useEffect, useMemo, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'

import { useRedirect } from '../../../navigation/redirect'
import { useTabParam } from '../../../navigation/useTabParam'
import { TabBar } from '../../primitives/TabBar'
import {
  ORGANISATION_SCOPE,
  resolveAdminScope,
  type AdminScopeOption,
  type AdminScopeResolution,
} from '../../../lib/admin-scope'

type UseAdminScopeInput = {
  ariaLabel: string
  /**
   * Params that belong to one scope's content rather than to the page — a
   * list's page, a roster's status strip. They leave in the same replace as a
   * scope change, so page 3 of one team's list is never applied to another's.
   */
  clears?: readonly string[]
  /** The teams could not be read. */
  failed?: boolean
  /** The page's entitlement-shaped choices; null while they are still loading. */
  options: readonly AdminScopeOption[] | null
  /** The team to land on when the organisation is not the viewer's. */
  preferredTeamId?: string | null
}

export type AdminScopeSwitch = {
  resolution: AdminScopeResolution
  /** The switch, for the header's tabs slot; absent when there is nothing to choose. */
  strip: ReactNode
}

const stripValue = (resolution: AdminScopeResolution): string =>
  resolution.status === 'ready' || resolution.status === 'landing' || resolution.status === 'unavailable'
    ? resolution.option.value
    : ''

/**
 * The one scope switch of the Organisation pages (`admin-scope.ts` has the
 * rules). The scope is `?scope=`, written with replace through `useTabParam`
 * like every other strip, with the organisation as the address that names
 * none. A viewer for whom the organisation is not theirs lands on a team, and
 * that team is written into the address with a replacing redirect before the
 * page shows anything under it — a write never targets a scope the address
 * does not name.
 */
export const useAdminScope = ({
  ariaLabel,
  clears,
  failed = false,
  options,
  preferredTeamId = null,
}: UseAdminScopeInput): AdminScopeSwitch => {
  const values = useMemo(() => (options ?? []).map((option) => option.value), [options])
  const [, select, requested] = useTabParam('scope', values, ORGANISATION_SCOPE, { clears })
  const resolution = resolveAdminScope({ failed, options, preferredTeamId, requested })

  const redirect = useRedirect()
  const location = useLocation()
  const landing = resolution.status === 'landing' ? resolution.option.value : null
  useEffect(() => {
    if (!landing) return
    const params = new URLSearchParams(location.search)
    // A list page in an address that named no scope was never this team's.
    for (const owned of clears ?? []) params.delete(owned)
    params.set('scope', landing)
    redirect(
      { hash: location.hash, pathname: location.pathname, search: `?${params.toString()}` },
      { state: location.state },
    )
  }, [clears, landing, location.hash, location.pathname, location.search, location.state, redirect])

  const choosable = resolution.status !== 'loading'
    && resolution.status !== 'failed'
    && resolution.status !== 'refused'
  // One choice is no choice — unless the address named something that is not
  // it, and the strip is how the person gets back to a scope that exists.
  const offered = choosable && options !== null
    && (options.length > 1 || resolution.status === 'unknown' || resolution.status === 'unavailable')

  const strip = offered ? (
    <TabBar
      ariaLabel={ariaLabel}
      items={options.map((option) => ({
        disabled: Boolean(option.unavailableReason),
        label: option.label,
        ...(option.unavailableReason ? { title: option.unavailableReason } : {}),
        value: option.value,
      }))}
      onChange={select}
      role="radiogroup"
      value={stripValue(resolution)}
    />
  ) : undefined

  return { resolution, strip }
}
