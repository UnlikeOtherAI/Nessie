import { Navigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { Select } from '../../../components/shared/FormControls'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { useIsOwner } from '../../../facades/auth/hooks'
import { useTeams } from '../../../facades/projects/hooks'
import { ModelAvailabilitySettings } from '../OrganizationModelsPage'

/**
 * The team's view of the shared Ledger catalogue. The server intersects this
 * list with organization availability before it reaches the browser, so a
 * team can narrow its choices but cannot discover or restore an org-disabled
 * provider/model pair.
 */
export const TeamModelsPage = () => {
  const { t } = useTranslation('settings')
  const { me } = useAuthSession()
  const isOwner = useIsOwner()
  const canManage = isOwner || (me?.user.roleIds.includes('admin') ?? false)
  const teams = useTeams()
  const [searchParams, setSearchParams] = useSearchParams()

  if (!me) return null
  if (!canManage) return <Navigate to="/settings/account" replace />

  const rows = teams.data ?? []
  const requestedTeamId = searchParams.get('team')
  const team = rows.find((row) => row.id === requestedTeamId) ?? rows[0]
  if (!team) return null

  const scopeControl = rows.length > 1 ? (
    <div className="w-full max-w-xs">
      <Select
        aria-label={t('team.team')}
        onChange={(event) => {
          setSearchParams((current) => {
            const next = new URLSearchParams(current)
            next.set('team', event.target.value)
            next.delete('cursor')
            next.delete('direction')
            next.delete('page')
            next.delete('scope')
            return next
          }, { replace: true })
        }}
        value={team.id}
      >
        {rows.map((row) => (
          <option key={row.id} value={row.id}>{row.name}</option>
        ))}
      </Select>
    </div>
  ) : null

  return (
    <ModelAvailabilitySettings
      scopeControl={scopeControl}
      teamId={team.id}
    />
  )
}
