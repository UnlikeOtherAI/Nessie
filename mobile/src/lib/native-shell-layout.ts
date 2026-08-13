import {
  ANDROID_TABLET_TAB_BAR_BOTTOM_GAP,
  ANDROID_TABLET_TAB_BAR_HEIGHT,
} from './android-tablet-dock'
import { getIpadContentTop } from './ipad-native-chrome'
import { TABS } from './tabs'

export const IPHONE_TAB_BAR_HEIGHT = 49
export const NATIVE_PHONE_MENU_HEADER_HEIGHT = 64

export type NativePhoneCreationAction = 'project' | 'channel' | 'message'

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

// The native bridge reports the SPA path together with its query string. The
// channel root is still the conversation index when it carries ordinary URL
// state, so normalize that structural suffix before deciding whether to render
// the workspace header and floating new-message action.
export const isNativePhoneConversationMenuRoute = (path: string | null): boolean => {
  const pathname = path?.split(/[?#]/, 1)[0]?.replace(/\/+$/, '')
  return pathname === '/channels'
}

// Android's dock is taller and raised above the safe area, so its native phone
// actions need their own exact bottom-chrome clearance.
export const getNativePhoneBottomChromeClearance = (platform: 'android' | 'ios'): number =>
  platform === 'android'
    ? ANDROID_TABLET_TAB_BAR_HEIGHT + ANDROID_TABLET_TAB_BAR_BOTTOM_GAP
    : IPHONE_TAB_BAR_HEIGHT

export const getNativePhoneComposeBottom = (bottomInset: number, platform: 'android' | 'ios'): number =>
  bottomInset + getNativePhoneBottomChromeClearance(platform) + 18

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
  showNativePhoneMenuHeader: boolean
  showTabBar: boolean
}): NativeSafeAreaInsets => {
  const top = input.isIpad && input.showTabBar
    ? getIpadContentTop(input.ipadChromeTop)
    : input.platform === 'ios' || input.platform === 'android'
      ? input.safeArea.top + (input.showNativePhoneMenuHeader ? NATIVE_PHONE_MENU_HEADER_HEIGHT : 0)
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
