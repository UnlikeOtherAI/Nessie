import assert from 'node:assert/strict'
import test from 'node:test'

import { ANDROID_TABLET_TAB_BAR_CONTENT_CLEARANCE } from './android-tablet-dock'
import { INJECTED } from './webview-inject'

type FakeElement = {
  content?: string
  id?: string
  name?: string
  textContent?: string
}

const injectedThemeMessage = (colorScheme: 'dark' | 'light'): Record<string, unknown> | undefined => {
  const elements = new Map<string, FakeElement>()
  const messages: Record<string, unknown>[] = []

  const appendChild = (element: FakeElement): void => {
    if (element.id) elements.set(element.id, element)
  }
  const document = {
    body: {},
    documentElement: {},
    head: { appendChild },
    addEventListener: (): void => undefined,
    createElement: (): FakeElement => ({}),
    getElementById: (id: string): FakeElement | null => elements.get(id) ?? null,
    querySelector: (): FakeElement | null => null,
  }
  const window = {
    __nessieNativeShell: { formFactor: 'phone', platform: 'ios' },
    addEventListener: (): void => undefined,
    location: { protocol: 'file:' },
    ReactNativeWebView: {
      postMessage: (message: string): void => {
        messages.push(JSON.parse(message) as Record<string, unknown>)
      },
    },
  }
  class FakeMutationObserver {
    constructor(_callback: () => void) {}

    observe(): void {}
  }
  const getComputedStyle = (): {
    backgroundColor: string
    colorScheme: string
    getPropertyValue: (name: string) => string
  } => ({
    backgroundColor: 'rgb(26, 29, 33)',
    colorScheme,
    getPropertyValue: (name) => {
      if (name === '--accent') return '#7c3aed'
      if (name === '--tx3') return '#949597'
      return '#222629'
    },
  })

  const runInjectedScript = new Function('window', 'document', 'MutationObserver', 'getComputedStyle', INJECTED)
  runInjectedScript(window, document, FakeMutationObserver, getComputedStyle)

  return messages.find((message) => message.type === 'theme')
}

const injectedSafeAreaCss = (platform: string, formFactor: string): string => {
  const elements = new Map<string, FakeElement>()
  const capture: { safeAreaStyle?: FakeElement } = {}

  const appendChild = (element: FakeElement): void => {
    if (element.id) elements.set(element.id, element)
    if (element.id === 'nessie-mobile-safe-area') capture.safeAreaStyle = element
  }
  const documentElement = {}
  const body = {}
  const document = {
    body,
    documentElement,
    head: { appendChild },
    addEventListener: (): void => undefined,
    createElement: (): FakeElement => ({}),
    getElementById: (id: string): FakeElement | null => elements.get(id) ?? null,
    querySelector: (): FakeElement | null => null,
  }
  const window = {
    __nessieNativeShell: { formFactor, platform },
    addEventListener: (): void => undefined,
    location: { protocol: 'file:' },
    ReactNativeWebView: { postMessage: (): void => undefined },
  }
  class FakeMutationObserver {
    constructor(_callback: () => void) {}

    observe(): void {}
  }
  const getComputedStyle = (): { backgroundColor: string; getPropertyValue: () => string } => ({
    backgroundColor: 'rgb(26, 29, 33)',
    getPropertyValue: () => '',
  })

  const runInjectedScript = new Function('window', 'document', 'MutationObserver', 'getComputedStyle', INJECTED)
  runInjectedScript(window, document, FakeMutationObserver, getComputedStyle)

  return capture.safeAreaStyle?.textContent ?? ''
}

test('iOS phone content clears the status bar and home indicator', () => {
  const css = injectedSafeAreaCss('ios', 'phone')

  assert.match(css, /padding-top: env\(safe-area-inset-top\)/)
  assert.match(css, /padding-bottom: env\(safe-area-inset-bottom\)/)
  assert.match(css, /body \{ background: var\(--main\); \}/)
})

test('iPad and Android keep top safe-area ownership in the native frame', () => {
  const ipadCss = injectedSafeAreaCss('ios', 'ipad')
  const androidCss = injectedSafeAreaCss('android', 'phone')

  assert.doesNotMatch(ipadCss, /padding-top/)
  assert.doesNotMatch(androidCss, /padding-top: env/)
  assert.doesNotMatch(ipadCss, /body \{ background: var\(--main\); \}/)
  assert.doesNotMatch(androidCss, /body \{ background: var\(--main\); \}/)
  assert.match(ipadCss, /padding-bottom: env\(safe-area-inset-bottom\)/)
  assert.match(androidCss, /padding-bottom: env\(safe-area-inset-bottom\)/)
  assert.match(
    androidCss,
    new RegExp(`--nessie-native-bottom-overlay: ${ANDROID_TABLET_TAB_BAR_CONTENT_CLEARANCE}px`),
  )
  assert.match(
    androidCss,
    /padding-bottom: calc\(var\(--nessie-native-bottom-overlay\) \+ env\(safe-area-inset-bottom\)\)/,
  )
  assert.match(androidCss, /\.admin-topbar \{ height: var\(--topbar-h\); padding-top: 0; \}/)
  assert.match(androidCss, /\[data-testid="channel-content-scroll"\] \{ overflow-x: hidden; \}/)
  assert.match(androidCss, /\.admin-message-code-block \{ overflow-x: auto; overflow-y: hidden; \}/)
})

test('reports the page color scheme for the native status bar', () => {
  assert.equal(injectedThemeMessage('light')?.scheme, 'light')
  assert.equal(injectedThemeMessage('dark')?.scheme, 'dark')
  assert.equal(injectedThemeMessage('dark')?.surface, '#222629')
})
