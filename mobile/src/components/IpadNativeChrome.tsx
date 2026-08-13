import { IpadNativeAccountMenu } from './IpadNativeAccountMenu'
import { IpadNativeToolbar, type ToolbarAction, type ToolbarState } from './IpadNativeToolbar'
import { IpadNativeTabBar } from './IpadNativeTabBar'
import { IpadNativeWorkspaceSwitcher } from './IpadNativeWorkspaceSwitcher'
import {
  getIpadAccountMenuLeft,
  getIpadToolbarLeft,
  getIpadWorkspaceWidth,
  IPAD_NATIVE_CHROME_GAP,
  type IpadNativeChromeTheme,
} from '../lib/ipad-native-chrome'

type IpadNativeChromeProps = {
  activeIndex: number
  account: {
    avatarUrl: string | null
    name: string | null
    presence: 'away' | 'offline' | 'online'
    statusEmoji: string | null
  }
  badgeCounts: { assignedWork: number; channels: number; knowledge: number }
  insetLeft: number
  insetRight: number
  onIndexChange: (index: number) => void
  onToggleAccountMenu: () => void
  onToolbarAction: (action: ToolbarAction) => void
  onToggleWorkspaceMenu: (left: number) => void
  onTabBarWidthChange: (width: number) => void
  tabBarWidth: number | null
  theme: IpadNativeChromeTheme
  toolbarState: ToolbarState
  top: number
  windowWidth: number
  workspaceName: string | null
}

export const IpadNativeChrome = ({
  activeIndex,
  account,
  badgeCounts,
  insetLeft,
  insetRight,
  onIndexChange,
  onTabBarWidthChange,
  onToggleAccountMenu,
  onToggleWorkspaceMenu,
  onToolbarAction,
  tabBarWidth,
  theme,
  toolbarState,
  top,
  windowWidth,
  workspaceName,
}: IpadNativeChromeProps): React.JSX.Element => {
  const toolbarLeft = tabBarWidth === null
    ? null
    : getIpadToolbarLeft(windowWidth, tabBarWidth, insetLeft)
  const workspaceWidth = toolbarLeft === null
    ? null
    : getIpadWorkspaceWidth(toolbarLeft, insetLeft)
  const accountLeft = tabBarWidth === null
    ? null
    : getIpadAccountMenuLeft(windowWidth, tabBarWidth, insetRight)
  const workspaceLeft = insetLeft + IPAD_NATIVE_CHROME_GAP

  return (
    <>
      <IpadNativeTabBar
        activeIndex={activeIndex}
        badgeCounts={badgeCounts}
        onIndexChange={onIndexChange}
        onWidthChange={onTabBarWidthChange}
        theme={theme}
        top={top}
      />
      {toolbarLeft !== null ? (
        <IpadNativeToolbar
          canBack={toolbarState.canBack}
          canForward={toolbarState.canForward}
          left={toolbarLeft}
          onAction={onToolbarAction}
          recentOpen={toolbarState.recentOpen}
          theme={theme}
          top={top}
        />
      ) : null}
      {workspaceName && workspaceWidth !== null ? (
        <IpadNativeWorkspaceSwitcher
          left={workspaceLeft}
          maxWidth={workspaceWidth}
          name={workspaceName}
          onPress={() => onToggleWorkspaceMenu(workspaceLeft)}
          theme={theme}
          top={top}
        />
      ) : null}
      {accountLeft !== null ? (
        <IpadNativeAccountMenu
          avatarUrl={account.avatarUrl}
          left={accountLeft}
          name={account.name}
          onPress={onToggleAccountMenu}
          presence={account.presence}
          statusEmoji={account.statusEmoji}
          theme={theme}
          top={top}
        />
      ) : null}
    </>
  )
}
