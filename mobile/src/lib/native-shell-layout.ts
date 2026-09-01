import {
  ANDROID_TABLET_TAB_BAR_BOTTOM_GAP,
  ANDROID_TABLET_TAB_BAR_HEIGHT,
} from './android-tablet-dock'
import { getIpadContentTop } from './ipad-native-chrome'
import { IPHONE_TAB_BAR_HEIGHT } from './iphone-tab-bar'
import { TABS } from './tabs'

export const NATIVE_PHONE_MENU_HEADER_HEIGHT = 64
export const NATIVE_PHONE_LANDSCAPE_HEADER_HEIGHT = 46
// Align the compact landscape header with the system's floating tab controls,
// rather than letting its workspace and account actions crowd the corners.
export const NATIVE_PHONE_LANDSCAPE_HORIZONTAL_GUTTER = 32

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

const nativePhoneTabRootPaths = new Set(TABS.map((tab) => tab.path))

// The native bridge reports the SPA path together with its query string. A tab
// root remains its first screen when it carries ordinary URL state, so normalize
// that structural suffix before deciding whether to render native home chrome.
const nativePhonePathname = (path: string | null): string | undefined =>
  path?.split(/[?#]/, 1)[0]?.replace(/\/+$/, '')

export const isNativePhoneTabRootRoute = (path: string | null): boolean => {
  const pathname = nativePhonePathname(path)
  return pathname != null && nativePhoneTabRootPaths.has(pathname)
}

export const isNativePhoneChannelsRootRoute = (path: string | null): boolean =>
  nativePhonePathname(path) === '/channels'

// Portrait only needs the workspace and account controls at a tab root. The
// admitted large-phone landscape lane has room for its compact toolbar on any
// page, so it retains the header while a detail is shown beside the menu.
export const shouldShowNativePhoneHeader = (input: {
  isIpad: boolean
  largePhoneLandscape: boolean
  path: string | null
  showBar: boolean
}): boolean => input.showBar
  && !input.isIpad
  && (input.largePhoneLandscape || isNativePhoneTabRootRoute(input.path))

export const getNativePhoneHeaderHeight = (landscape: boolean): number =>
  landscape ? NATIVE_PHONE_LANDSCAPE_HEADER_HEIGHT : NATIVE_PHONE_MENU_HEADER_HEIGHT

// Android's dock is taller and raised above the safe area, so its native phone
// actions need their own exact bottom-chrome clearance.
export const getNativePhoneBottomChromeClearance = (platform: 'android' | 'ios'): number =>
  platform === 'android'
    ? ANDROID_TABLET_TAB_BAR_HEIGHT + ANDROID_TABLET_TAB_BAR_BOTTOM_GAP
    : IPHONE_TAB_BAR_HEIGHT

export const getNativePhoneComposeBottom = (bottomInset: number, platform: 'android' | 'ios'): number =>
  bottomInset + getNativePhoneBottomChromeClearance(platform) + 18

/**
 * The native frame, not a DOM selector, owns the top unsafe edge. The iPhone
 * WebView deliberately reaches beneath the translucent native tab bar; the
 * injected web CSS clears the last scrollable item above that overlay.
 */
export const getNativeWebviewFrameInsets = (input: {
  ipadChromeTop: number
  isIpad: boolean
  nativePhoneHeaderHeight: number
  platform: string
  safeArea: NativeSafeAreaInsets
  showNativePhoneHeader: boolean
  showTabBar: boolean
}): NativeSafeAreaInsets => {
  const top = input.isIpad && input.showTabBar
    ? getIpadContentTop(input.ipadChromeTop)
    : input.platform === 'ios' || input.platform === 'android'
      ? input.safeArea.top + (input.showNativePhoneHeader ? input.nativePhoneHeaderHeight : 0)
      : 0
  const bottom = input.platform === 'android' ? input.safeArea.bottom : 0

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
