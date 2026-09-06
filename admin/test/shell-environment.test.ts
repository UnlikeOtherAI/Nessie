import assert from 'node:assert/strict'
import test from 'node:test'
import { readDesktopPlatform } from '../src/lib/desktop'
import { deriveShellEnvironment } from '../src/providers/ShellEnvironmentProvider'

// The mapping contract over navigation/mobile-shell.ts + lib/desktop.ts probes
// (docs/plans/2026-08-13-responsive-coherence.md §D): platform facts stay orthogonal
// to viewport width, so no input here is a width.

test('a plain browser is web/desktop with no native bridge', () => {
  assert.deepEqual(deriveShellEnvironment({ tauri: false, reactNativeWebView: false }), {
    runtime: 'web',
    platform: 'web',
    desktopPlatform: null,
    formFactor: 'desktop',
    hasNativeBridge: false,
  })
})

test('the Tauri desktop shell is its own runtime with a bridge', () => {
  assert.deepEqual(
    deriveShellEnvironment({ tauri: true, reactNativeWebView: false, desktopPlatform: 'macos' }),
    {
      runtime: 'tauri',
      platform: 'desktop',
      desktopPlatform: 'macos',
      formFactor: 'desktop',
      hasNativeBridge: true,
    },
  )
})

// The window chrome is the one thing that differs between the three desktop
// shells, so the platform has to survive the mapping intact.
test('each frameless desktop shell keeps its own platform', () => {
  for (const desktopPlatform of ['linux', 'windows'] as const) {
    assert.equal(
      deriveShellEnvironment({ tauri: true, reactNativeWebView: false, desktopPlatform })
        .desktopPlatform,
      desktopPlatform,
    )
  }
})

// A shell too old to publish the fact can only be the macOS release: it is the
// one that shipped before it, and the one whose chrome the OS draws anyway.
// Guessing 'windows' there would paint a second set of window controls over a
// Mac's traffic lights.
test('a desktop shell that publishes no platform is treated as macOS', () => {
  assert.equal(
    deriveShellEnvironment({ tauri: true, reactNativeWebView: false }).desktopPlatform,
    'macos',
  )
})

test('a mobile WebView and a browser have no desktop platform', () => {
  assert.equal(deriveShellEnvironment({ tauri: false, reactNativeWebView: false }).desktopPlatform, null)
  assert.equal(
    deriveShellEnvironment({ tauri: false, reactNativeWebView: true, nativePlatform: 'ios' })
      .desktopPlatform,
    null,
  )
})

test('an iPad WebView is react-native/tablet, never decided by viewport width', () => {
  assert.deepEqual(
    deriveShellEnvironment({
      tauri: false,
      reactNativeWebView: true,
      nativePlatform: 'ios',
      nativeFormFactor: 'ipad',
    }),
    {
      runtime: 'react-native',
      platform: 'ios',
      desktopPlatform: null,
      formFactor: 'tablet',
      hasNativeBridge: true,
    },
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
      {
        runtime: 'react-native',
        platform: nativePlatform,
        desktopPlatform: null,
        formFactor: 'phone',
        hasNativeBridge: true,
      },
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

// The probe is structural: it reads the value the Rust shell publishes before any
// admin code runs, and it never falls back to the user agent — WebKitGTK reports
// the same string on a Linux desktop as it does in a Linux browser tab.
test('the desktop platform is read from the published fact, never guessed', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const withWindow = (value: Record<string, unknown>): string | null => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value })
    return readDesktopPlatform()
  }
  try {
    assert.equal(withWindow({ __TAURI__: {}, __nessieDesktopPlatform: 'linux' }), 'linux')
    assert.equal(withWindow({ __TAURI__: {}, __nessieDesktopPlatform: 'windows' }), 'windows')
    assert.equal(withWindow({ __TAURI__: {}, __nessieDesktopPlatform: 'macos' }), 'macos')
    // Anything the shell did not publish, including a user-agent-shaped string.
    assert.equal(withWindow({ __TAURI__: {} }), null)
    assert.equal(withWindow({ __TAURI__: {}, __nessieDesktopPlatform: 'X11; Linux x86_64' }), null)
    assert.equal(withWindow({}), null)
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else delete (globalThis as { window?: unknown }).window
  }
})
