import assert from 'node:assert/strict'
import test from 'node:test'

import { INJECTED } from './webview-inject'

type FakeElement = {
  content?: string
  id?: string
  name?: string
  textContent?: string
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
})

test('iPad and Android keep top safe-area ownership in the native frame', () => {
  const ipadCss = injectedSafeAreaCss('ios', 'ipad')
  const androidCss = injectedSafeAreaCss('android', 'phone')

  assert.doesNotMatch(ipadCss, /padding-top/)
  assert.doesNotMatch(androidCss, /padding-top: env/)
  assert.match(ipadCss, /padding-bottom: env\(safe-area-inset-bottom\)/)
  assert.match(androidCss, /padding-bottom: env\(safe-area-inset-bottom\)/)
  assert.match(androidCss, /\.admin-topbar \{ height: var\(--topbar-h\); padding-top: 0; \}/)
  assert.match(androidCss, /\[data-testid="channel-content-scroll"\] \{ overflow-x: hidden; \}/)
  assert.match(androidCss, /\.admin-message-code-block \{ overflow-x: auto; overflow-y: hidden; \}/)
})
