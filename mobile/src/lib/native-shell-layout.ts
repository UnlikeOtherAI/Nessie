import { getIpadContentTop } from './ipad-native-chrome'
import { TABS } from './tabs'

export const IPHONE_TAB_BAR_HEIGHT = 49
export const IPHONE_MENU_HEADER_HEIGHT = 64

export type NativeSafeAreaInsets = {
  bottom: number
  top: number
}

export type NativeAttentionBadges = {
  assignedWork: number
  channels: number
  knowledge: number
}

type NativeTabRoute = {
  badge?: string
  key: string
  role?: 'search'
  title: string
}

export type NativeTabNavigationState = {
  index: number
  routes: NativeTabRoute[]
}

export const isAuthGateRoute = (path: string): boolean =>
  path.startsWith('/login') || path.startsWith('/bootstrap')

export const isFullScreenTaskRoute = (path: string): boolean => path === '/channels/new'

// The channel root is the conversation index; it is the only phone route that
// presents the workspace header and the floating new-message action.
export const isIphoneConversationMenuRoute = (path: string | null): boolean => path === '/channels'

/**
 * The native frame, not a DOM selector, owns unsafe screen edges. Phone pages
 * have several valid DOM shapes (notably the tab-root sidebars), so CSS alone
 * can miss a route and leave it under the status bar.
 */
export const getNativeWebviewFrameInsets = (input: {
  ipadChromeTop: number
  isIpad: boolean
  platform: string
  safeArea: NativeSafeAreaInsets
  showIphoneMenuHeader: boolean
  showTabBar: boolean
}): NativeSafeAreaInsets => {
  const top = input.isIpad && input.showTabBar
    ? getIpadContentTop(input.ipadChromeTop)
    : input.platform === 'ios' || input.platform === 'android'
      ? input.safeArea.top + (input.showIphoneMenuHeader ? IPHONE_MENU_HEADER_HEIGHT : 0)
      : 0
  const bottom = input.platform === 'android'
    ? input.safeArea.bottom
    : input.showTabBar && !input.isIpad
      ? IPHONE_TAB_BAR_HEIGHT + input.safeArea.bottom
      : 0

  return { top, bottom }
}

export const createNativeTabNavigationState = (
  index: number,
  badges: NativeAttentionBadges,
): NativeTabNavigationState => ({
  index,
  routes: TABS.map((tab) => {
    const value = tab.key === 'channels'
      ? badges.channels
      : tab.key === 'projects'
        ? badges.assignedWork
        : tab.key === 'knowledge'
          ? badges.knowledge
          : 0
    return {
      key: tab.key,
      title: tab.title,
      role: tab.role,
      badge: value > 0 ? String(value) : undefined,
    }
  }),
})
