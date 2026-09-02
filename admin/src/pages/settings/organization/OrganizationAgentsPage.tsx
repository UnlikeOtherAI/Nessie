import { CallProviderSettingsPanel } from './CallProviderSettingsPanel'
import { CloudBrowserPanel } from '../../../components/features/browser-cloud/CloudBrowserPanel'
import { SettingsPanel, type SettingsTabHostProps } from '../settings-shared'
import { useCurrentOrganization } from '../../../facades/organization/hooks'

/**
 * What agents across the organisation may use: where their calls are hosted,
 * and which cloud browser they drive. Both are defaults a team or a person can
 * override unless this level locks them.
 */
export const OrganizationAgentsPage = ({ tabs }: SettingsTabHostProps) => {
  const { data: organization } = useCurrentOrganization()

  return (
    <SettingsPanel eyebrow="Organization" title="Agents">
      {tabs}
      <div className="grid max-w-3xl gap-4">
        <CallProviderSettingsPanel />
        {organization?.role === 'owner' ? <CloudBrowserPanel scope="organization" /> : null}
      </div>
    </SettingsPanel>
  )
}
