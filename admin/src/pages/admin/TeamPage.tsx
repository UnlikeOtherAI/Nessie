import { useNavigate, useParams } from 'react-router-dom'

import { TabBar } from '../../components/primitives/TabBar'
import { QueryState } from '../../components/shared/QueryState'
import { SettingsPanel, type SettingsTabHostProps } from '../../components/shared/SettingsPanel'
import { useIsOrganizationAdmin } from '../../facades/auth/hooks'
import { useTeams } from '../../facades/projects/hooks'
import { useTabParam } from '../../navigation/useTabParam'
import { TeamOverridesPage } from '../settings/team/TeamOverridesPage'
import { TeamProfilePage } from '../settings/team/TeamProfilePage'

type TeamTab = 'general' | 'overrides'

const TEAM_TABS: readonly TeamTab[] = ['general', 'overrides']

const TAB_LABEL: Record<TeamTab, string> = {
  general: 'General',
  overrides: 'Overrides',
}

/**
 * One team's page, reached from Admin › Teams. The team is the one the address
 * names — never the team the person happens to be working in — so every team
 * is edited from its own page. General is who the team is and where its calls
 * go; Overrides is what it sets over the organisation, each linking to the
 * page that owns the setting with this team already chosen. The team page
 * never re-implements a setting: AI models, Company connections and Keys are
 * those pages at this team's scope.
 */
export const TeamPage = () => {
  const { teamId } = useParams<{ teamId: string }>()
  const navigate = useNavigate()
  const canManage = useIsOrganizationAdmin()
  const teams = useTeams()
  const [tab, setTab] = useTabParam('tab', TEAM_TABS, 'general')
  const team = teams.data?.find((row) => row.id === teamId)

  const host: SettingsTabHostProps = {
    backLabel: 'Back to Teams',
    eyebrow: 'Teams',
    onBack: () => void navigate('/admin/teams'),
    tabs: team && canManage ? (
      <TabBar
        ariaLabel="Team sections"
        items={TEAM_TABS.map((value) => ({ label: TAB_LABEL[value], value }))}
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
  return <TeamProfilePage host={host} team={team} />
}
