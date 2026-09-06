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
// rather than letting its team and account actions crowd the corners.
export const NATIVE_PHONE_LANDSCAPE_HORIZONTAL_GUTTER = 32

export type NativeCreationAction = 'project' | 'channel' | 'agent' | 'message'

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

/**
 * The admin's description of the native navigation bar for the layer showing.
 * `title` may be empty and `back` null — a layer that has not published yet
 * renders a bare band, never a root's team controls (see NativePhoneNavBar).
 */
export type NativeScreenBarMenuItem = {
  checked: boolean
  disabled: boolean
  id: string
  label: string
}

/**
 * One of the screen's own header actions. Everything here describes what the
 * action looks like; what it *does* stays in the web, behind its id — three of
 * the four kinds do not simply call an `onSelect` (a submit action's work is
 * in its form, a toggle inverts itself, a link may leave through the shell),
 * and reconstructing that natively would be a second implementation of the
 * header's semantics.
 */
/**
 * The glyphs this bar can draw, mirroring `ScreenBarIconName` in the admin.
 *
 * Closed on purpose: the bar stays text-first, and an icon vocabulary that
 * could grow freely across two repositories is the part most likely to rot.
 * A name this build does not know falls back to the label, so an action can
 * never be dropped for want of an icon.
 */
export type NativeScreenBarIconName = 'panel-right'

export type NativeScreenBarAction = {
  checked: boolean | null
  disabled: boolean
  icon?: NativeScreenBarIconName | string | null
  id: string
  items: NativeScreenBarMenuItem[] | null
  kind: 'button' | 'link' | 'menu' | 'toggle'
  label: string
  primary: boolean
  priority: number
  selected: boolean
  tone: 'danger' | null
}

/** A stack transition the bar runs alongside — see native-shell-message.ts. */
export type NativeScreenBarTransition = {
  direction: 'back' | 'forward'
  durationMs: number
  from: string
  to: string
}

export type NativeScreenBar = {
  actions: NativeScreenBarAction[]
  back: { label: string } | null
  layerKey: string | null
  title: string
}

export const isAuthGateRoute = (path: string): boolean =>
  path.startsWith('/login') || path.startsWith('/bootstrap')

export const isFullScreenTaskRoute = (path: string): boolean => path === '/channels/new'

export type NativePhoneBarInput = {
  isIpad: boolean
  // Android's own answer for the root lanes, from the last `nessie:screen`.
  // iOS does not use it: see `shouldShowNativePhoneRootLanes`.
  isTabRoot: boolean
  largePhoneLandscape: boolean
  platform: string
  // The admin's published descriptor for the layer showing, or null before
  // the first one of a cold start arrives.
  screenBar: NativeScreenBar | null
  // Whether the tab bar is showing. A full-screen task route hides it, which
  // on iOS must not also remove the band — see `shouldShowNativePhoneNavBar`.
  showBar: boolean
  // Past the login/bootstrap gate, whatever kind of screen this is. The band's
  // constant height holds for exactly this long.
  pastAuthGate: boolean
}

/**
 * Whether the native navigation band is drawn at all.
 *
 * On iOS the answer is **the same for every screen**, and that is the whole
 * point: the band's height feeds `getNativeWebviewFrameInsets`, so an answer
 * that varied by screen type would make the WebView's own frame a function of
 * navigation. That is what made a page jump 64pt when a back-swipe committed —
 * the frame resized, one whole animation after the motion it belonged to. See
 * docs/plans/2026-09-05-ios-native-navigation-bar.md §4.
 *
 * Android is unchanged: it still shows the band only where it shows the team
 * and account controls. The same machinery can be turned on for it later by
 * giving it the iOS answer here, but that is a separate decision.
 */
export const shouldShowNativePhoneNavBar = (input: NativePhoneBarInput): boolean => {
  if (input.isIpad) return false
  // On iOS the band spans everything past the auth gate — including a
  // full-screen task route like the compose flow, which hides the tab bar but
  // is entered and left through a real stack transition. Dropping the band
  // there would resize the WebView frame across that push, which is the same
  // defect in a second place.
  //
  // The auth gate itself keeps no chrome: it is only ever reached by a full
  // document load or a logout that replaces the whole app, never by a stack
  // transition, so that frame change is invisible and is accepted deliberately.
  if (input.platform === 'ios') return input.pastAuthGate
  return input.showBar && (input.largePhoneLandscape || input.isTabRoot)
}

/**
 * Whether the band carries the team identity and account controls — the root
 * lanes. Portrait only wants them at a tab root; the admitted large-phone
 * landscape lane has room for its compact toolbar on any page, so it keeps
 * them while a detail is shown beside the menu. `isTabRoot` comes from the
 * last-known screen's `type === 'root'`, never from matching a path.
 *
 * A phone screen that is not a root gets the band without these lanes. What it
 * carries instead — the back button, the title, the screen's actions — arrives
 * with the next slice; until then the band is bare surface, which is honest
 * rather than showing a team switcher above a conversation.
 */
export const shouldShowNativePhoneRootLanes = (input: NativePhoneBarInput): boolean => {
  if (!shouldShowNativePhoneNavBar(input)) return false
  if (input.largePhoneLandscape) return true
  // On iOS the lanes follow the **published descriptor**, never the screen
  // type. They are not the same question: `screenType` is the *pathname's*
  // registry type, and a nested stage never changes the pathname — so an open
  // Knowledge editor over a space root reports `root` and would be given a
  // team switcher instead of its own title and Back. A layer that published a
  // Back is not a root, whatever the route says.
  //
  // No descriptor yet — a cold start, the frame after a forward push — is a
  // bare band, deliberately. Falling back to the root lanes would flash a team
  // switcher above a conversation on the way to a push notification's target.
  if (input.platform === 'ios') return input.screenBar !== null && input.screenBar.back === null
  return input.isTabRoot
}

export const getNativePhoneHeaderHeight = (landscape: boolean): number =>
  landscape ? NATIVE_PHONE_LANDSCAPE_HEADER_HEIGHT : NATIVE_PHONE_MENU_HEADER_HEIGHT

// Android's dock is taller and raised above the safe area, so its native phone
// actions need their own exact bottom-chrome clearance.
export const getNativePhoneBottomChromeClearance = (platform: 'android' | 'ios'): number =>
  platform === 'android'
    ? ANDROID_TABLET_TAB_BAR_HEIGHT + ANDROID_TABLET_TAB_BAR_BOTTOM_GAP
    : IPHONE_TAB_BAR_HEIGHT

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
  // `shouldShowNativePhoneNavBar`'s answer — the band, not its contents. On
  // iOS this is constant past the auth gate, which is what keeps the frame
  // still while the stack animates.
  showNativePhoneNavBar: boolean
  showTabBar: boolean
}): NativeSafeAreaInsets => {
  const top = input.isIpad && input.showTabBar
    ? getIpadContentTop(input.ipadChromeTop)
    : input.platform === 'ios' || input.platform === 'android'
      ? input.safeArea.top + (input.showNativePhoneNavBar ? input.nativePhoneHeaderHeight : 0)
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
