import { CloudBrowserPanel } from '../../../components/features/browser-cloud/CloudBrowserPanel'
import { SettingsPanel, type SettingsTabHostProps } from '../../../components/shared/SettingsPanel'
import type { TeamRecord } from '../../../lib/api-client'

/**
 * What agents working for this team may use. A team account sits between the
 * company one and people's own: more specific than the organisation, less than
 * a person, and shared — so a scheduled run may spend it.
 */
export const TeamAgentsPage = ({ tabs, team }: SettingsTabHostProps & { team?: TeamRecord }) => (
  <SettingsPanel eyebrow="Team" title="Agents">
    {tabs}
    <div className="grid gap-4">
      {team ? <CloudBrowserPanel scope="team" teamId={team.id} /> : null}
    </div>
  </SettingsPanel>
)
