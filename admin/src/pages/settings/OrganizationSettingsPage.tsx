import { useTranslation } from 'react-i18next'
import { OrganizationAgentsPage } from './organization/OrganizationAgentsPage'
import { OrganizationAppearancePage } from './organization/OrganizationAppearancePage'
import { OrganizationProfilePage } from './organization/OrganizationProfilePage'
import { OrganizationAdministrationGate } from './OrganizationAdministrationGate'
import { TabBar } from '../../components/primitives/TabBar'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useTabParam } from '../../navigation/useTabParam'

const ORGANIZATION_SETTINGS_TABS = ['profile', 'agents', 'appearance'] as const

type OrganizationSettingsTab = (typeof ORGANIZATION_SETTINGS_TABS)[number]

const PAGES: Record<
  OrganizationSettingsTab,
  (props: { tabs?: React.ReactNode }) => React.JSX.Element | null
> = {
  agents: OrganizationAgentsPage,
  appearance: OrganizationAppearancePage,
  profile: OrganizationProfilePage,
}

export const OrganizationSettingsPage = () => {
  const { t } = useTranslation('settings')
  const { me } = useAuthSession()
  const [activeTab, setActiveTab] = useTabParam('tab', ORGANIZATION_SETTINGS_TABS, 'profile')

  if (!me) {
    return null
  }

  const ActivePage = PAGES[activeTab]
  const tabs = (
    <div className="-mt-1 mb-4 flex items-center">
      <TabBar
        ariaLabel={t('organization.settingsSections')}
        items={[
          { label: t('profile.title'), value: 'profile' as const },
          { label: t('team.agents'), value: 'agents' as const },
          { label: t('organization.appearance'), value: 'appearance' as const },
        ]}
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
