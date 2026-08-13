import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createNativeTabNavigationState,
  getNativeWebviewFrameInsets,
  isAuthGateRoute,
  isIphoneConversationMenuRoute,
} from './native-shell-layout'

test('the iPhone native frame always owns the status and tab-bar safe areas', () => {
  assert.deepEqual(getNativeWebviewFrameInsets({
    ipadChromeTop: 0,
    isIpad: false,
    platform: 'ios',
    safeArea: { top: 59, bottom: 34 },
    showIphoneMenuHeader: false,
    showTabBar: true,
  }), { top: 59, bottom: 83 })
})

test('full-screen iPhone tasks keep the status inset while leaving the home indicator to the web surface', () => {
  assert.deepEqual(getNativeWebviewFrameInsets({
    ipadChromeTop: 0,
    isIpad: false,
    platform: 'ios',
    safeArea: { top: 59, bottom: 34 },
    showIphoneMenuHeader: false,
    showTabBar: false,
  }), { top: 59, bottom: 0 })
})

test('iPad and Android retain their respective native-frame geometry', () => {
  assert.deepEqual(getNativeWebviewFrameInsets({
    ipadChromeTop: 24,
    isIpad: true,
    platform: 'ios',
    safeArea: { top: 24, bottom: 20 },
    showIphoneMenuHeader: false,
    showTabBar: true,
  }), { top: 78, bottom: 0 })
  assert.deepEqual(getNativeWebviewFrameInsets({
    ipadChromeTop: 0,
    isIpad: false,
    platform: 'android',
    safeArea: { top: 32, bottom: 28 },
    showIphoneMenuHeader: false,
    showTabBar: true,
  }), { top: 32, bottom: 28 })
})

test('the iPhone conversation index reserves the native workspace header', () => {
  assert.deepEqual(getNativeWebviewFrameInsets({
    ipadChromeTop: 59,
    isIpad: false,
    platform: 'ios',
    safeArea: { top: 59, bottom: 34 },
    showIphoneMenuHeader: true,
    showTabBar: true,
  }), { top: 123, bottom: 83 })
  assert.equal(isIphoneConversationMenuRoute('/channels'), true)
  assert.equal(isIphoneConversationMenuRoute('/channels/new'), false)
  assert.equal(isIphoneConversationMenuRoute('/projects'), false)
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
