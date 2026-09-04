import { OrganizationAgentsPage } from './organization/OrganizationAgentsPage'
import { OrganizationProfilePage } from './organization/OrganizationProfilePage'
import { OrganizationAdministrationGate } from './OrganizationAdministrationGate'
import { TabBar } from '../../components/primitives/TabBar'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useTabParam } from '../../navigation/useTabParam'

const ORGANIZATION_SETTINGS_TABS = ['profile', 'agents'] as const

type OrganizationSettingsTab = (typeof ORGANIZATION_SETTINGS_TABS)[number]

const TABS: ReadonlyArray<{ label: string; value: OrganizationSettingsTab }> = [
  { label: 'Profile', value: 'profile' },
  { label: 'Agents', value: 'agents' },
]

const PAGES: Record<
  OrganizationSettingsTab,
  (props: { tabs?: React.ReactNode }) => React.JSX.Element | null
> = {
  agents: OrganizationAgentsPage,
  profile: OrganizationProfilePage,
}

export const OrganizationSettingsPage = () => {
  const { me } = useAuthSession()
  const [activeTab, setActiveTab] = useTabParam('tab', ORGANIZATION_SETTINGS_TABS, 'profile')

  if (!me) {
    return null
  }

  const ActivePage = PAGES[activeTab]
  const tabs = (
    <div className="-mt-1 mb-4 flex items-center">
      <TabBar
        ariaLabel="Organisation settings sections"
        items={TABS}
        onChange={setActiveTab}
        value={activeTab}
      />
    </div>
  )

  return (
    <OrganizationAdministrationGate>
      <ActivePage tabs={tabs} />
    </OrganizationAdministrationGate>
  )
}
