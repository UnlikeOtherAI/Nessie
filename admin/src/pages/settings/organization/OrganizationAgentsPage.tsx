import { CallProviderSettingsPanel } from './CallProviderSettingsPanel'
import { CloudBrowserPanel } from '../../../components/features/browser-cloud/CloudBrowserPanel'
import { MailboxConnectionsPanel } from '../../../components/features/mailbox-connections/MailboxConnectionsPanel'
import { SettingsPanel, type SettingsTabHostProps } from '../settings-shared'
import { useCurrentOrganization } from '../../../facades/organization/hooks'
import { useMailboxConnections } from '../../../facades/mailbox-connections/hooks'
import { useConnectionAnchorScroll } from '../../../components/features/mailbox-connections/useConnectionAnchorScroll'

/**
 * What agents across the organisation may use: where their calls are hosted,
 * and which cloud browser they drive. Both are defaults a team or a person can
 * override unless this level locks them.
 */
export const OrganizationAgentsPage = ({ tabs }: SettingsTabHostProps) => {
  const { data: organization } = useCurrentOrganization()
  const mailboxes = useMailboxConnections()
  useConnectionAnchorScroll(mailboxes.isSuccess)

  return (
    <SettingsPanel eyebrow="Organization" title="Agents">
      {tabs}
      <div className="grid gap-4">
        <CallProviderSettingsPanel />
        <MailboxConnectionsPanel scope="team" />
        {organization?.role === 'owner' ? <CloudBrowserPanel scope="organization" /> : null}
      </div>
    </SettingsPanel>
  )
}
