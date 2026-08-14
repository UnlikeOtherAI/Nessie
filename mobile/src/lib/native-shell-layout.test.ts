import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createNativeTabNavigationState,
  getNativePhoneBottomChromeClearance,
  getNativePhoneComposeBottom,
  getNativePhoneHeaderHeight,
  getNativeWebviewFrameInsets,
  isAuthGateRoute,
  isNativePhoneChannelsRootRoute,
  isNativePhoneTabRootRoute,
  shouldShowNativePhoneHeader,
} from './native-shell-layout'
import { getIphoneTabBarHostHeight, IPHONE_TAB_BAR_HEIGHT } from './iphone-tab-bar'

test('the iPhone native frame keeps page content beneath the translucent tab bar', () => {
  assert.deepEqual(getNativeWebviewFrameInsets({
    ipadChromeTop: 0,
    isIpad: false,
    nativePhoneHeaderHeight: getNativePhoneHeaderHeight(false),
    platform: 'ios',
    safeArea: { top: 59, bottom: 34 },
    showNativePhoneHeader: false,
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
    showNativePhoneHeader: false,
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
    showNativePhoneHeader: false,
    showTabBar: true,
  }), { top: 78, bottom: 0 })
  assert.deepEqual(getNativeWebviewFrameInsets({
    ipadChromeTop: 0,
    isIpad: false,
    nativePhoneHeaderHeight: getNativePhoneHeaderHeight(false),
    platform: 'android',
    safeArea: { top: 32, bottom: 28 },
    showNativePhoneHeader: false,
    showTabBar: true,
  }), { top: 32, bottom: 28 })
})

test('every native phone tab root reserves the workspace header on iPhone and Android', () => {
  assert.deepEqual(getNativeWebviewFrameInsets({
    ipadChromeTop: 59,
    isIpad: false,
    nativePhoneHeaderHeight: getNativePhoneHeaderHeight(false),
    platform: 'ios',
    safeArea: { top: 59, bottom: 34 },
    showNativePhoneHeader: true,
    showTabBar: true,
  }), { top: 123, bottom: 0 })
  assert.equal(isNativePhoneTabRootRoute('/channels'), true)
  assert.equal(isNativePhoneTabRootRoute('/channels?source=tab'), true)
  assert.equal(isNativePhoneTabRootRoute('/channels/'), true)
  assert.equal(isNativePhoneTabRootRoute('/projects'), true)
  assert.equal(isNativePhoneTabRootRoute('/knowledge-base'), true)
  assert.equal(isNativePhoneTabRootRoute('/settings'), true)
  assert.equal(isNativePhoneTabRootRoute('/search'), true)
  assert.equal(isNativePhoneTabRootRoute('/channels/new'), false)
  assert.equal(isNativePhoneChannelsRootRoute('/channels'), true)
  assert.equal(isNativePhoneChannelsRootRoute('/projects'), false)
  assert.deepEqual(getNativeWebviewFrameInsets({
    ipadChromeTop: 0,
    isIpad: false,
    nativePhoneHeaderHeight: getNativePhoneHeaderHeight(false),
    platform: 'android',
    safeArea: { top: 32, bottom: 28 },
    showNativePhoneHeader: true,
    showTabBar: true,
  }), { top: 96, bottom: 28 })
  assert.equal(getNativePhoneBottomChromeClearance('ios'), 49)
  assert.equal(getNativePhoneBottomChromeClearance('android'), 78)
  assert.equal(getNativePhoneComposeBottom(34, 'ios'), 101)
  assert.equal(getNativePhoneComposeBottom(28, 'android'), 124)
})

test('an admitted phone keeps a shorter native header on every landscape page', () => {
  assert.equal(shouldShowNativePhoneHeader({
    isIpad: false,
    largePhoneLandscape: true,
    path: '/channels/channel_1',
    showBar: true,
  }), true)
  assert.equal(shouldShowNativePhoneHeader({
    isIpad: false,
    largePhoneLandscape: false,
    path: '/channels/channel_1',
    showBar: true,
  }), false)
  assert.equal(getNativePhoneHeaderHeight(true) < getNativePhoneHeaderHeight(false), true)
  assert.deepEqual(getNativeWebviewFrameInsets({
    ipadChromeTop: 0,
    isIpad: false,
    nativePhoneHeaderHeight: getNativePhoneHeaderHeight(true),
    platform: 'ios',
    safeArea: { top: 0, bottom: 21 },
    showNativePhoneHeader: true,
    showTabBar: true,
  }), { top: getNativePhoneHeaderHeight(true), bottom: 0 })
})

test('the native tab state keeps attention badges scoped to their owning tab', () => {
  const state = createNativeTabNavigationState(0, {
    assignedWork: 2,
    channels: 3,
    knowledge: 0,
  })
  assert.equal(state.routes.find((route) => route.key === 'channels')?.badge, '3')
  assert.equal(state.routes.find((route) => route.key === 'projects')?.badge, '2')
  assert.equal(state.routes.find((route) => route.key === 'knowledge')?.badge, undefined)
  assert.equal(isAuthGateRoute('/login'), true)
  assert.equal(isAuthGateRoute('/channels'), false)
})
