import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isConnectorAuthorizationMessage,
  isConnectorAuthorizationUrl,
  openConnectorAuthorizationUrl,
} from './connector-authorization'
import { handleNativeShellMessage } from './native-shell-message-handler'
import type { NativeShellMessage } from './native-shell-message'
import { DEFAULT_LAST_KNOWN_SCREEN } from './native-shell-layout'

test('connector authorization accepts only a credential-free HTTPS URL', () => {
  assert.equal(isConnectorAuthorizationUrl('https://idp.example/authorize?state=one'), true)
  assert.equal(isConnectorAuthorizationUrl('http://idp.example/authorize'), false)
  assert.equal(isConnectorAuthorizationUrl('javascript:alert(1)'), false)
  assert.equal(isConnectorAuthorizationUrl('https://person:secret@idp.example/authorize'), false)
  assert.equal(isConnectorAuthorizationUrl('not a URL'), false)
})

test('the narrow bridge message launches connector authorization, never a call link', () => {
  const connectorUrls: string[] = []
  const externalUrls: string[] = []
  const externalAuthUrls: string[] = []
  const input = {
    acknowledgeExternalAuthDelivery: () => undefined,
    acknowledgePushPath: () => false,
    currentPathRef: { current: null },
    dismissNativeMenus: () => undefined,
    dismissNotifications: () => undefined,
    dispatchPresentation: () => undefined,
    endNativeVoiceCall: () => undefined,
    ensureNativePushRegistration: () => undefined,
    flushExternalAuthDelivery: () => undefined,
    lastKnownScreen: DEFAULT_LAST_KNOWN_SCREEN,
    markBooted: () => undefined,
    noteBackState: () => undefined,
    openConnectorAuthorization: (url: string) => connectorUrls.push(url),
    openExternalUrl: (url: string) => externalUrls.push(url),
    reconcileNativeAttention: async () => undefined,
    replayPendingPushPath: () => null,
    runExternalAuth: async (url: string) => { externalAuthUrls.push(url) },
    runScript: () => undefined,
    screenActiveRef: { current: false },
    setCurrentPath: () => undefined,
    setIndex: () => undefined,
    setLastKnownScreen: () => undefined,
    setScreenBar: () => undefined,
    setNativeVoiceCallMuted: () => undefined,
    startNativeVoiceCall: () => undefined,
    triggerHaptic: () => undefined,
  }
  const message = {
    authorizationUrl: 'https://idp.example/authorize?state=one',
    type: 'nessie:connector-authorization',
  }

  assert.equal(isConnectorAuthorizationMessage(message), true)
  handleNativeShellMessage(message, input)

  assert.deepEqual(connectorUrls, ['https://idp.example/authorize?state=one'])
  assert.deepEqual(externalUrls, [])
  assert.deepEqual(externalAuthUrls, [])
})

test('the haptic bridge message routes to the native trigger, never a connector or call URL', () => {
  const connectorUrls: string[] = []
  const externalUrls: string[] = []
  const hapticKinds: string[] = []
  const input = {
    acknowledgeExternalAuthDelivery: () => undefined,
    acknowledgePushPath: () => false,
    currentPathRef: { current: null },
    dismissNativeMenus: () => undefined,
    dismissNotifications: () => undefined,
    dispatchPresentation: () => undefined,
    endNativeVoiceCall: () => undefined,
    ensureNativePushRegistration: () => undefined,
    flushExternalAuthDelivery: () => undefined,
    lastKnownScreen: DEFAULT_LAST_KNOWN_SCREEN,
    markBooted: () => undefined,
    noteBackState: () => undefined,
    openConnectorAuthorization: (url: string) => connectorUrls.push(url),
    openExternalUrl: (url: string) => externalUrls.push(url),
    reconcileNativeAttention: async () => undefined,
    replayPendingPushPath: () => null,
    runExternalAuth: async () => undefined,
    runScript: () => undefined,
    screenActiveRef: { current: false },
    setCurrentPath: () => undefined,
    setIndex: () => undefined,
    setLastKnownScreen: () => undefined,
    setScreenBar: () => undefined,
    setNativeVoiceCallMuted: () => undefined,
    startNativeVoiceCall: () => undefined,
    triggerHaptic: (kind: string) => hapticKinds.push(kind),
  }

  handleNativeShellMessage({ type: 'nessie:haptic', haptic: 'warning' }, input)

  assert.deepEqual(hapticKinds, ['warning'])
  assert.deepEqual(connectorUrls, [])
  assert.deepEqual(externalUrls, [])

  // An unknown kind is not the haptic message at all — it falls through
  // rather than reaching the native trigger with a value expo-haptics cannot map.
  const unknownKind = { type: 'nessie:haptic', haptic: 'extreme' } as unknown as NativeShellMessage
  handleNativeShellMessage(unknownKind, input)
  assert.deepEqual(hapticKinds, ['warning'])
})

test('the native shell opens only a validated connector authorization URL', async () => {
  const opened: string[] = []
  assert.equal(
    openConnectorAuthorizationUrl('https://idp.example/authorize?state=one', async (url) => {
      opened.push(url)
    }),
    true,
  )
  await Promise.resolve()
  assert.deepEqual(opened, ['https://idp.example/authorize?state=one'])

  assert.equal(
    openConnectorAuthorizationUrl('https://person:secret@idp.example/authorize', async (url) => {
      opened.push(url)
    }),
    false,
  )
  assert.deepEqual(opened, ['https://idp.example/authorize?state=one'])
})

test('contains a synchronous connector authorization launcher failure', () => {
  let result: boolean | undefined

  assert.doesNotThrow(() => {
    result = openConnectorAuthorizationUrl('https://idp.example/authorize?state=one', () => {
      throw new Error('native launcher lost its receiver')
    })
  })

  assert.equal(result, true)
})
