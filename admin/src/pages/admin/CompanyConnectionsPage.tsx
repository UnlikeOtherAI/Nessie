import { CloudBrowserPanel } from '../../components/features/browser-cloud/CloudBrowserPanel'
import { MailboxConnectionsPanel } from '../../components/features/mailbox-connections/MailboxConnectionsPanel'
import { SettingsPanel } from '../../components/shared/SettingsPanel'
import { useCurrentOrganization } from '../../facades/organization/hooks'
import { OrganizationAdministrationGate } from '../settings/OrganizationAdministrationGate'

/**
 * Company connections: the accounts the organisation connects on behalf of its
 * agents — the shared mailboxes teams work in, and the company's own cloud
 * browser. Named apart from Apps on purpose: an app is a capability from the
 * catalogue, and this is what the company has signed in to.
 *
 * Where each team's calls are hosted is that team's own setting, on its page
 * under Teams.
 */
export const CompanyConnectionsPage = () => {
  const { data: organization } = useCurrentOrganization()
  const host = { title: 'Company connections' }

  return (
    <OrganizationAdministrationGate host={host}>
      <SettingsPanel eyebrow="Organisation" title="Company connections">
        <div className="grid gap-4">
          <MailboxConnectionsPanel scope="team" />
          {organization?.role === 'owner' ? <CloudBrowserPanel scope="organization" /> : null}
        </div>
      </SettingsPanel>
    </OrganizationAdministrationGate>
  )
}
