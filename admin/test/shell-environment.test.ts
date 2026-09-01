import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveShellEnvironment } from '../src/providers/ShellEnvironmentProvider'

// The mapping contract over lib/mobile-shell.ts + lib/desktop.ts probes
// (docs/plans/2026-08-13-responsive-coherence.md §D): platform facts stay orthogonal
// to viewport width, so no input here is a width.

test('a plain browser is web/desktop with no native bridge', () => {
  assert.deepEqual(deriveShellEnvironment({ tauri: false, reactNativeWebView: false }), {
    runtime: 'web',
    platform: 'web',
    formFactor: 'desktop',
    hasNativeBridge: false,
  })
})

test('the Tauri desktop shell is its own runtime with a bridge', () => {
  assert.deepEqual(deriveShellEnvironment({ tauri: true, reactNativeWebView: false }), {
    runtime: 'tauri',
    platform: 'desktop',
    formFactor: 'desktop',
    hasNativeBridge: true,
  })
})

test('an iPad WebView is react-native/tablet, never decided by viewport width', () => {
  assert.deepEqual(
    deriveShellEnvironment({
      tauri: false,
      reactNativeWebView: true,
      nativePlatform: 'ios',
      nativeFormFactor: 'ipad',
    }),
    { runtime: 'react-native', platform: 'ios', formFactor: 'tablet', hasNativeBridge: true },
  )
})

test('a phone WebView is react-native/phone on either mobile platform', () => {
  for (const nativePlatform of ['ios', 'android']) {
    assert.deepEqual(
      deriveShellEnvironment({
        tauri: false,
        reactNativeWebView: true,
        nativePlatform,
        nativeFormFactor: 'phone',
      }),
      { runtime: 'react-native', platform: nativePlatform, formFactor: 'phone', hasNativeBridge: true },
    )
  }
})

test('unreported native shell info keeps the roomier tablet form factor', () => {
  const environment = deriveShellEnvironment({ tauri: false, reactNativeWebView: true })
  assert.equal(environment.runtime, 'react-native')
  assert.equal(environment.platform, 'unknown')
  assert.equal(environment.formFactor, 'tablet')
  assert.equal(environment.hasNativeBridge, true)
})

test('the React Native WebView takes precedence over a stray Tauri global', () => {
  const environment = deriveShellEnvironment({ tauri: true, reactNativeWebView: true })
  assert.equal(environment.runtime, 'react-native')
})
