import { Navigate, useSearchParams } from 'react-router-dom'

import { Select } from '../../components/shared/FormControls'
import { TabBar } from '../../components/primitives/TabBar'
import { TeamAgentsPage } from './team/TeamAgentsPage'
import { TeamProfilePage } from './team/TeamProfilePage'
import type { TeamRecord } from '../../lib/api-client'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useIsOwner } from '../../components/shared/OwnerGate'
import { useTabParam } from '../../navigation/useTabParam'
import { useTeams } from '../../facades/projects/hooks'

const TEAM_SETTINGS_TABS = ['profile', 'agents'] as const

type TeamSettingsTab = (typeof TEAM_SETTINGS_TABS)[number]

const TABS: ReadonlyArray<{ label: string; value: TeamSettingsTab }> = [
  { label: 'Profile', value: 'profile' },
  { label: 'Agents', value: 'agents' },
]

const PAGES: Record<
  TeamSettingsTab,
  (props: { tabs?: React.ReactNode; team?: TeamRecord }) => React.JSX.Element | null
> = {
  agents: TeamAgentsPage,
  profile: TeamProfilePage,
}

export const TeamSettingsPage = () => {
  const { me } = useAuthSession()
  const isOwner = useIsOwner()
  const canManage = isOwner || (me?.user.roleIds.includes('admin') ?? false)
  const [activeTab, setActiveTab] = useTabParam('tab', TEAM_SETTINGS_TABS, 'profile')
  // The team is a free-form id rather than a closed set, so it is a plain
  // search param written with `replace` — a team switch changes what the
  // screen shows, not which entry the reader is standing on.
  const [searchParams, setSearchParams] = useSearchParams()
  const teamId = searchParams.get('team')
  const setTeamId = (next: string) =>
    setSearchParams((current) => {
      const params = new URLSearchParams(current)
      params.set('team', next)
      return params
    }, { replace: true })
  const teams = useTeams()

  if (!me) return null
  if (!canManage) return <Navigate to="/settings/account" replace />

  const rows: TeamRecord[] = teams.data ?? []
  const team = rows.find((row) => row.id === teamId) ?? rows[0]
  const ActivePage = PAGES[activeTab]

  const tabs = (
    <div className="-mt-1 mb-4 flex flex-wrap items-center gap-3">
      <TabBar
        ariaLabel="Team settings sections"
        items={TABS}
        onChange={setActiveTab}
        value={activeTab}
      />
      {rows.length > 1 ? (
        <Select
          aria-label="Team"
          onChange={(event) => setTeamId(event.target.value)}
          value={team?.id ?? ''}
        >
          {rows.map((row) => (
            <option key={row.id} value={row.id}>{row.name}</option>
          ))}
        </Select>
      ) : null}
    </div>
  )

  return <ActivePage tabs={tabs} team={team} />
}
