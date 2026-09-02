import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { NATIVE_BACK_FORWARD_GESTURES } from './webview-back-gesture'
import { shouldInstallNativeBackHandler } from './native-phone-navigation'

// The native back/forward swipe is a WebView-wide switch that cannot be
// scoped to a column; the admin's stack owns the edge swipe on phones and
// every screen header carries a Back on the wider layouts, so the switch is
// off everywhere (docs/navigation.md §10).
test('the native back/forward gesture is off on every form factor', () => {
  assert.equal(NATIVE_BACK_FORWARD_GESTURES, false)
  const webView = readFileSync(join(process.cwd(), 'src', 'components', 'MobileAdminWebView.tsx'), 'utf8')
  assert.match(webView, /allowsBackForwardNavigationGestures=\{NATIVE_BACK_FORWARD_GESTURES\}/)
  const app = readFileSync(join(process.cwd(), 'App.tsx'), 'utf8')
  assert.doesNotMatch(app, /allowsNativeBackForwardGestures|nativeBackForwardGestures/)
})

// Android's hardware Back listener is a separate decision and installs on
// every Android form factor regardless of the gesture switch.
test('the gesture switch never gates the hardware Back handler', () => {
  assert.equal(shouldInstallNativeBackHandler(true), true)
})
