import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createNativeTabNavigationState,
  getNativePhoneBottomChromeClearance,
  getNativePhoneComposeBottom,
  getNativePhoneHeaderHeight,
  getNativeWebviewFrameInsets,
  isAuthGateRoute,
  NATIVE_PHONE_LANDSCAPE_HORIZONTAL_GUTTER,
  shouldShowNativePhoneNavBar,
  shouldShowNativePhoneRootLanes,
} from './native-shell-layout'
import { getIphoneTabBarHostHeight, IPHONE_TAB_BAR_HEIGHT } from './iphone-tab-bar'

test('the iPhone native frame keeps page content beneath the translucent tab bar', () => {
  assert.deepEqual(getNativeWebviewFrameInsets({
    ipadChromeTop: 0,
    isIpad: false,
    nativePhoneHeaderHeight: getNativePhoneHeaderHeight(false),
    platform: 'ios',
    safeArea: { top: 59, bottom: 34 },
    showNativePhoneNavBar: false,
    showTabBar: true,
  }), { top: 59, bottom: 0 })
  assert.equal(getIphoneTabBarHostHeight(34), IPHONE_TAB_BAR_HEIGHT + 34)
  assert.equal(getIphoneTabBarHostHeight(-2), IPHONE_TAB_BAR_HEIGHT)
})

test('full-screen iPhone tasks keep the status inset while leaving the home indicator to the web surface', () => {
  assert.deepEqual(getNativeWebviewFrameInsets({
    ipadChromeTop: 0,
    isIpad: false,
    nativePhoneHeaderHeight: getNativePhoneHeaderHeight(false),
    platform: 'ios',
    safeArea: { top: 59, bottom: 34 },
    showNativePhoneNavBar: false,
    showTabBar: false,
  }), { top: 59, bottom: 0 })
})

test('iPad and Android retain their respective native-frame geometry', () => {
  assert.deepEqual(getNativeWebviewFrameInsets({
    ipadChromeTop: 24,
    isIpad: true,
    nativePhoneHeaderHeight: getNativePhoneHeaderHeight(false),
    platform: 'ios',
    safeArea: { top: 24, bottom: 20 },
    showNativePhoneNavBar: false,
    showTabBar: true,
  }), { top: 78, bottom: 0 })
  assert.deepEqual(getNativeWebviewFrameInsets({
    ipadChromeTop: 0,
    isIpad: false,
    nativePhoneHeaderHeight: getNativePhoneHeaderHeight(false),
    platform: 'android',
    safeArea: { top: 32, bottom: 28 },
    showNativePhoneNavBar: false,
    showTabBar: true,
  }), { top: 32, bottom: 28 })
})

test('every native phone tab root reserves the team header on iPhone and Android', () => {
  assert.deepEqual(getNativeWebviewFrameInsets({
    ipadChromeTop: 59,
    isIpad: false,
    nativePhoneHeaderHeight: getNativePhoneHeaderHeight(false),
    platform: 'ios',
    safeArea: { top: 59, bottom: 34 },
    showNativePhoneNavBar: true,
    showTabBar: true,
  }), { top: 123, bottom: 0 })
  assert.deepEqual(getNativeWebviewFrameInsets({
    ipadChromeTop: 0,
    isIpad: false,
    nativePhoneHeaderHeight: getNativePhoneHeaderHeight(false),
    platform: 'android',
    safeArea: { top: 32, bottom: 28 },
    showNativePhoneNavBar: true,
    showTabBar: true,
  }), { top: 96, bottom: 28 })
  assert.equal(getNativePhoneBottomChromeClearance('ios'), 49)
  assert.equal(getNativePhoneBottomChromeClearance('android'), 78)
  assert.equal(getNativePhoneComposeBottom(34, 'ios'), 101)
  assert.equal(getNativePhoneComposeBottom(28, 'android'), 124)
})

test('an admitted phone keeps a shorter native header on every landscape page', () => {
  // A detail screen in the admitted large-phone-landscape lane keeps the
  // compact header regardless of whether it is a tab root.
  assert.equal(shouldShowNativePhoneRootLanes({
    isIpad: false,
    isTabRoot: false,
    largePhoneLandscape: true,
    platform: 'ios',
    pastAuthGate: true,
    screenBar: null,
    showBar: true,
  }), true)
  // Off that lane, only a tab root carries the team and account controls.
  assert.equal(shouldShowNativePhoneRootLanes({
    isIpad: false,
    isTabRoot: false,
    largePhoneLandscape: false,
    platform: 'ios',
    pastAuthGate: true,
    screenBar: null,
    showBar: true,
  }), false)
  assert.equal(shouldShowNativePhoneRootLanes({
    isIpad: false,
    isTabRoot: true,
    largePhoneLandscape: false,
    platform: 'ios',
    pastAuthGate: true,
    screenBar: { actions: [], back: null, layerKey: 'channels:0:root:channels:/channels', title: '' },
    showBar: true,
  }), true)
  assert.equal(getNativePhoneHeaderHeight(true) < getNativePhoneHeaderHeight(false), true)
  assert.equal(NATIVE_PHONE_LANDSCAPE_HORIZONTAL_GUTTER, 32)
  assert.deepEqual(getNativeWebviewFrameInsets({
    ipadChromeTop: 0,
    isIpad: false,
    nativePhoneHeaderHeight: getNativePhoneHeaderHeight(true),
    platform: 'ios',
    safeArea: { top: 0, bottom: 21 },
    showNativePhoneNavBar: true,
    showTabBar: true,
  }), { top: getNativePhoneHeaderHeight(true), bottom: 0 })
})

test('the native tab state keeps attention badges scoped to their owning tab', () => {
  const state = createNativeTabNavigationState(0, {
    channels: 3,
    projects: 2,
    knowledge: 0,
  })
  assert.equal(state.routes.find((route) => route.key === 'channels')?.badge, '3')
  assert.equal(state.routes.find((route) => route.key === 'projects')?.badge, '2')
  assert.equal(state.routes.find((route) => route.key === 'knowledge')?.badge, undefined)
  // A section the caller omits (admin, search here) defaults to no badge.
  assert.equal(state.routes.find((route) => route.key === 'admin')?.badge, undefined)
  assert.equal(state.routes.find((route) => route.key === 'search')?.badge, undefined)
  assert.equal(isAuthGateRoute('/login'), true)
  assert.equal(isAuthGateRoute('/channels'), false)
})

test('the iOS phone band is one constant height, whatever screen the admin reports', () => {
  // The invariant the native navigation bar exists to hold
  // (docs/plans/2026-09-05-ios-native-navigation-bar.md §4). The WebView's own
  // frame is derived from this band, so an answer that moved with the screen
  // type made the page jump 64pt when a back-swipe committed — one whole
  // animation after the motion it belonged to.
  const insetFor = (isTabRoot: boolean): number => {
    const input = {
      isIpad: false,
      isTabRoot,
      largePhoneLandscape: false,
      platform: 'ios',
      pastAuthGate: true,
      screenBar: null,
      showBar: true,
    }
    return getNativeWebviewFrameInsets({
      ipadChromeTop: 0,
      isIpad: false,
      nativePhoneHeaderHeight: getNativePhoneHeaderHeight(false),
      platform: 'ios',
      safeArea: { top: 59, bottom: 34 },
      showNativePhoneNavBar: shouldShowNativePhoneNavBar(input),
      showTabBar: true,
    }).top
  }
  assert.equal(insetFor(true), insetFor(false))
  assert.equal(insetFor(false), 123)

  // Android keeps exactly the answer it had: the band only where the team and
  // account controls are. Turning it on there is a separate decision.
  const androidInput = (isTabRoot: boolean) => ({
    isIpad: false,
    isTabRoot,
    largePhoneLandscape: false,
    pastAuthGate: true,
    platform: 'android',
    // Android never receives a descriptor — the bridge posts it only on the
    // iOS shell — so its lanes must keep reading the screen type.
    screenBar: null,
    showBar: true,
  })
  assert.equal(shouldShowNativePhoneNavBar(androidInput(true)), true)
  assert.equal(shouldShowNativePhoneNavBar(androidInput(false)), false)
  assert.equal(
    shouldShowNativePhoneNavBar(androidInput(false)),
    shouldShowNativePhoneRootLanes(androidInput(false)),
  )

  // An iPhone detail draws the band without the root lanes.
  const iosDetail = {
    isIpad: false,
    isTabRoot: false,
    largePhoneLandscape: false,
    platform: 'ios',
    pastAuthGate: true,
    screenBar: null,
    showBar: true,
  }
  assert.equal(shouldShowNativePhoneNavBar(iosDetail), true)
  assert.equal(shouldShowNativePhoneRootLanes(iosDetail), false)

  // The band spans everything past the auth gate, including a full-screen task
  // route that hides the tab bar: the compose flow is entered and left through
  // a real stack transition, so dropping the band there would resize the frame
  // across that push — the same defect in a second place.
  assert.equal(shouldShowNativePhoneNavBar({ ...iosDetail, showBar: false }), true)
  // The gate itself keeps no chrome. It is only reached by a full document
  // load, never by a transition, so that frame change is invisible.
  assert.equal(
    shouldShowNativePhoneNavBar({ ...iosDetail, pastAuthGate: false, showBar: false }),
    false,
  )
  // Android is unmoved: no tab bar, no band.
  assert.equal(shouldShowNativePhoneNavBar({
    ...iosDetail,
    isTabRoot: true,
    platform: 'android',
    showBar: false,
  }), false)
})

test('the iOS lanes follow the published descriptor, never the screen type', () => {
  // The defect the descriptor exists to prevent: `screenType` is the
  // *pathname's* registry type, and a nested stage never changes the
  // pathname. An open Knowledge editor over a space root reports `root`, and
  // keying the lanes off that hands it a team switcher instead of its own
  // title and Back.
  const base = {
    isIpad: false,
    largePhoneLandscape: false,
    pastAuthGate: true,
    platform: 'ios',
    showBar: true,
  }
  const editorOverARoot = {
    ...base,
    isTabRoot: true,
    screenBar: {
      actions: [],
      back: { label: 'Back to folder' },
      layerKey: 'knowledge:1:stage:knowledge:editor',
      title: 'Onboarding',
    },
  }
  assert.equal(shouldShowNativePhoneRootLanes(editorOverARoot), false)

  const trueRoot = {
    ...base,
    isTabRoot: true,
    screenBar: { actions: [], back: null, layerKey: 'channels:0:root:channels:/channels', title: '' },
  }
  assert.equal(shouldShowNativePhoneRootLanes(trueRoot), true)

  // A detail whose route still says root — and the reverse — both follow the
  // descriptor.
  assert.equal(shouldShowNativePhoneRootLanes({ ...editorOverARoot, isTabRoot: false }), false)
  assert.equal(shouldShowNativePhoneRootLanes({ ...trueRoot, isTabRoot: false }), true)

  // Before the first descriptor of a cold start: a bare band, never a team
  // switcher flashing above a push notification's target.
  assert.equal(shouldShowNativePhoneRootLanes({ ...base, isTabRoot: true, screenBar: null }), false)

  // Android is unmoved by any of this.
  assert.equal(shouldShowNativePhoneRootLanes({
    ...base,
    isTabRoot: true,
    platform: 'android',
    pastAuthGate: true,
    screenBar: null,
  }), true)
})
