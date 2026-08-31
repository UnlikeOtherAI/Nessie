import assert from 'node:assert/strict'
import test from 'node:test'

import { nativeExternalAuthDeliveryScript } from './external-auth-delivery'
import { nativeBackScript, nativeSelectTabScript } from './native-phone-navigation'
import {
  nativeAppForegroundScript,
  nativePhoneTabBarClearanceScript,
  nativePushPathScript,
  nativeShellInfoScript,
  wrapNativeWebViewScript,
} from './native-shell'
import { INJECTED } from './webview-inject'

const scriptBuilders: ReadonlyArray<{ name: string; script: () => string }> = [
  {
    name: 'nativeExternalAuthDeliveryScript',
    script: () => nativeExternalAuthDeliveryScript({ id: 1, url: 'nessie://auth/callback?code=code' }),
  },
  { name: 'nativeSelectTabScript', script: () => nativeSelectTabScript('/channels') },
  { name: 'nativeBackScript', script: () => nativeBackScript() },
  {
    name: 'nativeShellInfoScript',
    script: () => nativeShellInfoScript({
      bottomInset: 0,
      clientId: 'client-id',
      formFactor: 'phone',
      pendingPushPath: null,
      platform: 'ios',
    }),
  },
  { name: 'nativePhoneTabBarClearanceScript', script: () => nativePhoneTabBarClearanceScript(0) },
  { name: 'nativePushPathScript(path)', script: () => nativePushPathScript('/channels') },
  { name: 'nativePushPathScript(null)', script: () => nativePushPathScript(null) },
  { name: 'nativeAppForegroundScript', script: () => nativeAppForegroundScript(true) },
  { name: 'INJECTED', script: () => INJECTED },
]

for (const { name, script } of scriptBuilders) {
  test(`${name} terminates and parses through the native WebView wrapper`, () => {
    const source = script()
    assert.match(source, /;\s*$/)
    const wrapped = wrapNativeWebViewScript(source)
    assert.match(wrapped, /\ntrue;$/)
    assert.doesNotThrow(() => new Function(wrapped))
  })
}
