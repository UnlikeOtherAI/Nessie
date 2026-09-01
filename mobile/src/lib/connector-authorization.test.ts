import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isConnectorAuthorizationMessage,
  isConnectorAuthorizationUrl,
  openConnectorAuthorizationUrl,
} from './connector-authorization'
import { handleNativeShellMessage } from './native-shell-message-handler'

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
    currentPath: null,
    currentPathRef: { current: null },
    dismissNativeMenus: () => undefined,
    dismissNotifications: () => undefined,
    dispatchPresentation: () => undefined,
    ensureNativePushRegistration: () => undefined,
    flushExternalAuthDelivery: () => undefined,
    markBooted: () => undefined,
    noteBackState: () => undefined,
    openConnectorAuthorization: (url: string) => connectorUrls.push(url),
    openExternalUrl: (url: string) => externalUrls.push(url),
    reconcileNativeAttention: async () => undefined,
    replayPendingPushPath: () => null,
    runExternalAuth: async (url: string) => { externalAuthUrls.push(url) },
    runScript: () => undefined,
    setCurrentPath: () => undefined,
    setIndex: () => undefined,
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
