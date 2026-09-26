import { useNavigate, useParams } from 'react-router-dom'

import { ModelAvailabilitySettings } from '../../components/features/inference-models/ModelAvailabilitySettings'
import { TabBar } from '../../components/primitives/TabBar'
import { QueryState } from '../../components/shared/QueryState'
import { SettingsPanel, type SettingsTabHostProps } from '../../components/shared/SettingsPanel'
import { useIsOwner } from '../../facades/auth/hooks'
import { useTeams } from '../../facades/projects/hooks'
import { useTabParam } from '../../navigation/useTabParam'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { SecretsPanel } from '../settings/SecretsPanel'
import { TeamOverridesPage } from '../settings/team/TeamOverridesPage'
import { TeamProfilePage } from '../settings/team/TeamProfilePage'

type TeamTab = 'general' | 'overrides' | 'models' | 'keys'

// Keys are the owner's: writing a team key is owner-gated, so its tab is too.
// A member of either list is a valid address for everybody, so an admin who
// follows an owner's `?tab=keys` link lands on General rather than nothing.
const OWNER_TABS: readonly TeamTab[] = ['general', 'overrides', 'models', 'keys']
const ADMIN_TABS: readonly TeamTab[] = ['general', 'overrides', 'models']

const TAB_LABEL: Record<TeamTab, string> = {
  general: 'General',
  keys: 'Keys',
  models: 'AI models',
  overrides: 'Overrides',
}

/**
 * One team's page, reached from Admin › Teams. The team is the one the address
 * names — never the team the person happens to be working in — so every team
 * is edited from its own page. General is who the team is and where its calls
 * go; Overrides, AI models and Keys are what it sets over the organisation.
 */
export const TeamPage = () => {
  const { teamId } = useParams<{ teamId: string }>()
  const navigate = useNavigate()
  const { me } = useAuthSession()
  const isOwner = useIsOwner()
  const canManage = isOwner || (me?.user.roleIds.includes('admin') ?? false)
  const teams = useTeams()
  const tabs = isOwner ? OWNER_TABS : ADMIN_TABS
  const [tab, setTab] = useTabParam('tab', tabs, 'general')
  const team = teams.data?.find((row) => row.id === teamId)

  const host: SettingsTabHostProps = {
    backLabel: 'Back to Teams',
    eyebrow: 'Teams',
    onBack: () => void navigate('/admin/teams'),
    tabs: team && canManage ? (
      <TabBar
        ariaLabel="Team sections"
        items={tabs.map((value) => ({ label: TAB_LABEL[value], value }))}
        onChange={setTab}
        value={tab}
      />
    ) : undefined,
    title: team?.name ?? 'Team',
  }

  if (!canManage) {
    return (
      <SettingsPanel eyebrow="Teams" host={host} title="Team">
        <p className="text-sm text-[color:var(--tx2)]">
          Only organisation owners and admins manage teams.
        </p>
      </SettingsPanel>
    )
  }

  if (!team) {
    // Loading, failure and a team this organisation does not have are states
    // of this screen, under its own header, never a fall-back to another team.
    return (
      <SettingsPanel eyebrow="Teams" host={host} title="Team">
        <QueryState
          className="py-12"
          emptyLabel="This team isn’t in your organisation."
          errorLabel="Teams could not be loaded."
          isEmpty
          loadingLabel="Loading team…"
          query={teams}
        >
          {() => null}
        </QueryState>
      </SettingsPanel>
    )
  }

  if (tab === 'overrides') return <TeamOverridesPage host={host} team={team} />
  if (tab === 'models') return <ModelAvailabilitySettings host={host} teamId={team.id} />
  if (tab === 'keys') return <SecretsPanel host={host} scope="team" teamId={team.id} />
  return <TeamProfilePage host={host} team={team} />
}
