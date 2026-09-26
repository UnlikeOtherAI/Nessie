import { CloudBrowserPanel } from '../../../components/features/browser-cloud/CloudBrowserPanel'
import { LocalInferenceEnablement } from '../../../components/features/local-inference/LocalInferenceEnablement'
import { SettingsPanel, type SettingsTabHostProps } from '../../../components/shared/SettingsPanel'
import type { TeamRecord } from '../../../lib/api-client'

/**
 * What this team sets for its own work over the organisation's defaults: the
 * cloud browser its agents use, and whether its people may run AI models on
 * their own computers. A team account sits between the company's and people's
 * own: more specific than the organisation, less than a person, and shared —
 * so a scheduled run may spend it.
 */
export const TeamOverridesPage = ({ host, team }: { host?: SettingsTabHostProps; team: TeamRecord }) => (
  <SettingsPanel eyebrow="Teams" host={host} title="Overrides">
    <div className="grid gap-4">
      <CloudBrowserPanel scope="team" teamId={team.id} />
      <LocalInferenceEnablement scope="team" teamId={team.id} />
    </div>
  </SettingsPanel>
)
