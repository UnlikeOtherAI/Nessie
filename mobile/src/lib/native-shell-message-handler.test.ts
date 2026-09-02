import assert from 'node:assert/strict'
import test from 'node:test'

import { handleNativeShellMessage } from './native-shell-message-handler'
import { DEFAULT_LAST_KNOWN_SCREEN, type LastKnownScreen } from './native-shell-layout'
import { TABS } from './tabs'

const buildInput = () => {
  const state = {
    hapticKinds: [] as string[],
    index: 0,
    lastBackDepth: undefined as boolean | undefined,
    lastKnownScreen: DEFAULT_LAST_KNOWN_SCREEN as LastKnownScreen,
  }
  const screenActiveRef = { current: false }
  const input = {
    acknowledgeExternalAuthDelivery: () => undefined,
    acknowledgePushPath: () => false,
    currentPathRef: { current: null as string | null },
    dismissNativeMenus: () => undefined,
    dismissNotifications: () => undefined,
    dispatchPresentation: () => undefined,
    ensureNativePushRegistration: () => undefined,
    flushExternalAuthDelivery: () => undefined,
    get lastKnownScreen() { return state.lastKnownScreen },
    markBooted: () => undefined,
    noteBackState: (hasBackDepth: boolean) => { state.lastBackDepth = hasBackDepth },
    openConnectorAuthorization: () => undefined,
    openExternalUrl: () => undefined,
    reconcileNativeAttention: async () => undefined,
    replayPendingPushPath: () => null,
    runExternalAuth: async () => undefined,
    runScript: () => undefined,
    screenActiveRef,
    setCurrentPath: () => undefined,
    setIndex: (value: number | ((current: number) => number)) => {
      state.index = typeof value === 'function' ? value(state.index) : value
    },
    setLastKnownScreen: (screen: LastKnownScreen) => { state.lastKnownScreen = screen },
    triggerHaptic: (kind: string) => state.hapticKinds.push(kind),
  }
  return { input, screenActiveRef, state }
}

test('nessie:screen updates the last-known screen and selects its section\'s tab', () => {
  const { input, state } = buildInput()

  handleNativeShellMessage({
    depth: 2,
    hasBack: true,
    path: '/knowledge-base/space_1/page_1',
    screenType: 'detail',
    section: 'knowledge',
    title: 'Runbook',
    type: 'nessie:screen',
  }, input)

  assert.deepEqual(state.lastKnownScreen, {
    depth: 2,
    hasBack: true,
    section: 'knowledge',
    title: 'Runbook',
    type: 'detail',
  })
  assert.equal(state.index, TABS.findIndex((tab) => tab.key === 'knowledge'))
})

test('hardware Back consumption follows nessie:screen.hasBack', () => {
  const { input, state } = buildInput()

  handleNativeShellMessage({
    depth: 0,
    hasBack: false,
    path: '/channels',
    screenType: 'root',
    section: 'channels',
    title: 'Channels',
    type: 'nessie:screen',
  }, input)
  assert.equal(state.lastBackDepth, false)

  handleNativeShellMessage({
    depth: 1,
    hasBack: true,
    path: '/channels/channel_1',
    screenType: 'detail',
    section: 'channels',
    title: 'General',
    type: 'nessie:screen',
  }, input)
  assert.equal(state.lastBackDepth, true)
})

// During the admin's transition the shell may still see a plain
// nessie:back-state message; once nessie:screen has started arriving it
// stays authoritative and a stale back-state no longer overrides it.
test('nessie:screen wins over a nessie:back-state message once it has arrived', () => {
  const { input, screenActiveRef, state } = buildInput()

  // Before any nessie:screen message, back-state applies normally.
  handleNativeShellMessage({ hasBackDepth: true, type: 'nessie:back-state' }, input)
  assert.equal(state.lastBackDepth, true)
  assert.equal(screenActiveRef.current, false)

  handleNativeShellMessage({
    depth: 0,
    hasBack: false,
    path: '/channels',
    screenType: 'root',
    section: 'channels',
    title: 'Channels',
    type: 'nessie:screen',
  }, input)
  assert.equal(screenActiveRef.current, true)
  assert.equal(state.lastBackDepth, false)

  // A stale nessie:back-state arriving afterward no longer overrides it.
  handleNativeShellMessage({ hasBackDepth: true, type: 'nessie:back-state' }, input)
  assert.equal(state.lastBackDepth, false)
})

test('nessie:search-overlay closing restores the last-known section\'s tab, not a path match', () => {
  const { input, state } = buildInput()

  handleNativeShellMessage({
    depth: 0,
    hasBack: false,
    path: '/settings',
    screenType: 'root',
    section: 'admin',
    title: 'Settings',
    type: 'nessie:screen',
  }, input)
  assert.equal(state.index, TABS.findIndex((tab) => tab.key === 'admin'))

  handleNativeShellMessage({ active: true, type: 'nessie:search-overlay' }, input)
  assert.equal(state.index, TABS.findIndex((tab) => tab.key === 'search'))

  handleNativeShellMessage({ active: false, type: 'nessie:search-overlay' }, input)
  assert.equal(state.index, TABS.findIndex((tab) => tab.key === 'admin'))
})
