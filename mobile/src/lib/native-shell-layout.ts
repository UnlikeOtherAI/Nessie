import {
  ANDROID_TABLET_TAB_BAR_BOTTOM_GAP,
  ANDROID_TABLET_TAB_BAR_HEIGHT,
} from './android-tablet-dock'
import { getIpadContentTop } from './ipad-native-chrome'
import { IPHONE_TAB_BAR_HEIGHT } from './iphone-tab-bar'
import { DEFAULT_TAB_KEY, TABS, type TabKey } from './tabs'
import type { ScreenType } from './native-shell-message'

export const NATIVE_PHONE_MENU_HEADER_HEIGHT = 64
export const NATIVE_PHONE_LANDSCAPE_HEADER_HEIGHT = 46
// Align the compact landscape header with the system's floating tab controls,
// rather than letting its workspace and account actions crowd the corners.
export const NATIVE_PHONE_LANDSCAPE_HORIZONTAL_GUTTER = 32

export type NativePhoneCreationAction = 'project' | 'channel' | 'agent' | 'message'

export type NativeSafeAreaInsets = {
  bottom: number
  top: number
}

// A badge count per section; a section the admin has not reported reads as 0
// (see native-shell-presentation.ts `attentionBadges`).
export type NativeAttentionBadges = Partial<Record<TabKey, number>>

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

// The shell's own picture of what the WebView is currently showing, built
// entirely from the latest `nessie:screen` bridge message — never from
// matching its `path` against a copy of the admin's routing table. `type`
// here is the screen's own node type (root/detail/nested/tabHost/flow), as
// opposed to the bridge message's `type` field, which is always the fixed
// discriminant `'nessie:screen'`.
export type LastKnownScreen = {
  depth: number
  hasBack: boolean
  section: TabKey
  title: string
  type: ScreenType
}

// Before the first `nessie:screen` message of a cold start arrives: the
// Channels tab, treated as a root with nothing to go back to.
export const DEFAULT_LAST_KNOWN_SCREEN: LastKnownScreen = {
  depth: 0,
  hasBack: false,
  section: DEFAULT_TAB_KEY,
  title: '',
  type: 'root',
}

export const isAuthGateRoute = (path: string): boolean =>
  path.startsWith('/login') || path.startsWith('/bootstrap')

export const isFullScreenTaskRoute = (path: string): boolean => path === '/channels/new'

// Portrait only needs the workspace and account controls at a tab root. The
// admitted large-phone landscape lane has room for its compact toolbar on any
// page, so it retains the header while a detail is shown beside the menu.
// `isTabRoot` comes from the last-known screen's `type === 'root'`, not from
// matching a path.
export const shouldShowNativePhoneHeader = (input: {
  isIpad: boolean
  isTabRoot: boolean
  largePhoneLandscape: boolean
  showBar: boolean
}): boolean => input.showBar
  && !input.isIpad
  && (input.largePhoneLandscape || input.isTabRoot)

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
    const value = badges[tab.key] ?? 0
    return {
      key: tab.key,
      title: tab.title,
      role: tab.role,
      badge: value > 0 ? String(value) : undefined,
    }
  }),
})
