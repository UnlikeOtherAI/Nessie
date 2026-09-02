import { AppearancePage } from './AppearancePage'
import { NotificationsPage } from './NotificationsPage'
import { SecuritySettingsPage } from './SecuritySettingsPage'
import { SettingsProfilePage } from './SettingsProfilePage'
import { TabBar } from '../../components/primitives/TabBar'
import { UserAgentsPage } from './UserAgentsPage'
import { useTabParam } from '../../navigation/useTabParam'

export const USER_SETTINGS_TABS = [
  'profile',
  'agents',
  'notifications',
  'appearance',
  'security',
] as const

export type UserSettingsTab = (typeof USER_SETTINGS_TABS)[number]

const TABS: ReadonlyArray<{ label: string; value: UserSettingsTab }> = [
  { label: 'Profile', value: 'profile' },
  { label: 'Agents', value: 'agents' },
  { label: 'Notifications', value: 'notifications' },
  { label: 'Appearance', value: 'appearance' },
  { label: 'Security', value: 'security' },
]

const PAGES: Record<UserSettingsTab, (props: { tabs?: React.ReactNode }) => React.JSX.Element | null> = {
  agents: UserAgentsPage,
  appearance: AppearancePage,
  notifications: NotificationsPage,
  profile: SettingsProfilePage,
  security: SecuritySettingsPage,
}

/**
 * One home for everything that is settings *about you* — the four pages that
 * used to sit separately in the sidebar, plus what your agents may use on your
 * behalf. The tab strip is owned here and passed down; each page keeps its own
 * header and actions, so exactly one header renders at a time.
 */
export const UserSettingsPage = () => {
  const [activeTab, setActiveTab] = useTabParam('tab', USER_SETTINGS_TABS, 'profile')
  const ActivePage = PAGES[activeTab]

  const tabs = (
    <div className="-mt-1 mb-4 flex items-center">
      <TabBar
        ariaLabel="Account settings sections"
        items={TABS}
        onChange={setActiveTab}
        value={activeTab}
      />
    </div>
  )

  return <ActivePage tabs={tabs} />
}
