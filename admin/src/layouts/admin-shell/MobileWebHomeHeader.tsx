import { UserMenuTrigger } from './UserMenuTrigger'
import { RecentChannelsControl } from './topbar-navigation'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'

type MobileWebHomeHeaderProps = {
  onLogout: () => void
}

// The browser version of native phone home chrome. Its controls deliberately
// reuse the same workspace, recents, and account components as desktop/iPad.
export const MobileWebHomeHeader = ({ onLogout }: MobileWebHomeHeaderProps): React.JSX.Element => {
  return (
    <header className="mobile-web-home-header">
      <WorkspaceSwitcher variant="mobile-header" />
      <div className="flex shrink-0 items-center gap-2">
        <RecentChannelsControl buttonClassName="mobile-web-home-action" />
        <UserMenuTrigger
          className="mobile-web-home-action"
          onLogout={onLogout}
          placement="topbar"
          ringColor="var(--ink)"
        />
      </div>
    </header>
  )
}
