import { Navigate } from 'react-router-dom'
import { OrganizationAgentsPage } from './organization/OrganizationAgentsPage'
import { OrganizationProfilePage } from './organization/OrganizationProfilePage'
import { TabBar } from '../../components/primitives/TabBar'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useIsOwner } from '../../components/shared/OwnerGate'
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
  // Team call settings follow their API route: owners and admins can change
  // them. The organisation's own route authorizes the same two roles, so the
  // page remains one coherent home for its profile and agent controls.
  const isOwner = useIsOwner()
  const canManageOrganization = isOwner || (me?.user.roleIds.includes('admin') ?? false)
  const [activeTab, setActiveTab] = useTabParam('tab', ORGANIZATION_SETTINGS_TABS, 'profile')

  if (!me) {
    return null
  }

  if (!canManageOrganization) {
    return <Navigate to="/settings/account" replace />
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

  return <ActivePage tabs={tabs} />
}
