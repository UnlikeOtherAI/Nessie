import { TabBar } from '../../components/primitives/TabBar'
import { useTabParam } from '../../navigation/useTabParam'
import { OrganizationAdministrationGate } from '../settings/OrganizationAdministrationGate'
import { OrganizationAppearancePage } from '../settings/organization/OrganizationAppearancePage'
import { OrganizationProfilePage } from '../settings/organization/OrganizationProfilePage'

const ORGANIZATION_TABS = ['profile', 'appearance'] as const

type OrganizationTab = (typeof ORGANIZATION_TABS)[number]

const TABS: ReadonlyArray<{ label: string; value: OrganizationTab }> = [
  { label: 'Profile', value: 'profile' },
  { label: 'Appearance', value: 'appearance' },
]

/**
 * Admin › Organisation: who the organisation is (its name and logo) and how it
 * looks (the palette it offers everyone). The connections it holds are Company
 * connections, and each team's call provider is on that team's page.
 */
export const OrganizationPage = () => {
  const [activeTab, setActiveTab] = useTabParam('tab', ORGANIZATION_TABS, 'profile')
  const host = {
    eyebrow: 'Admin',
    tabs: (
      <TabBar
        ariaLabel="Organisation sections"
        items={TABS}
        onChange={setActiveTab}
        value={activeTab}
      />
    ),
    title: 'Organisation',
  }

  return (
    <OrganizationAdministrationGate host={host}>
      {activeTab === 'appearance'
        ? <OrganizationAppearancePage host={host} />
        : <OrganizationProfilePage host={host} />}
    </OrganizationAdministrationGate>
  )
}
