import assert from 'node:assert/strict'
import test from 'node:test'

import { ANDROID_TABLET_TAB_BAR_CONTENT_CLEARANCE } from './android-tablet-dock'
import { IPHONE_TAB_BAR_HEIGHT } from './iphone-tab-bar'
import { INJECTED, isDark, parseRgb } from './webview-inject'

type FakeElement = {
  content?: string
  id?: string
  name?: string
  textContent?: string
}

const injectedThemeMessage = (
  colorScheme: 'dark' | 'light',
  tokens: { rail?: string; text?: string } = {},
): Record<string, unknown> | undefined => {
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
      if (name === '--accent-strong') return '#5b21b6'
      if (name === '--tx3') return '#949597'
      if (name === '--panel') return '#222629'
      if (name === '--tx') return tokens.text ?? '#f8f5ef'
      if (name === '--tx2') return '#b6b0a9'
      if (name === '--on-accent') return '#ffffff'
      if (name === '--rail') return tokens.rail ?? '#2e1132'
      return '#222629'
    },
  })

  const runInjectedScript = new Function('window', 'document', 'MutationObserver', 'getComputedStyle', INJECTED)
  runInjectedScript(window, document, FakeMutationObserver, getComputedStyle)

  return messages.find((message) => message.type === 'theme')
}

const injectedSafeAreaCss = (platform: string, formFactor: string, bottomInset = 0): string => {
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
    __nessieNativeShell: { bottomInset, formFactor, platform },
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

test('iOS phone injection clears the tab overlay inside the WebView', () => {
  const css = injectedSafeAreaCss('ios', 'phone', 34)

  assert.doesNotMatch(css, /padding-top: env\(safe-area-inset-top\)/)
  assert.match(css, /padding-bottom: env\(safe-area-inset-bottom\)/)
  assert.match(css, /body \{ background: var\(--main\); \}/)
  assert.match(
    css,
    new RegExp(`--nessie-native-phone-tabbar-clearance: ${IPHONE_TAB_BAR_HEIGHT + 34}px`),
  )
  const phoneTabBarScrollSurfaces =
    '\\.admin-frame\\.has-native-phone-tabbar \\.nessie-native-phone-tabbar-scroll'
  const phoneTabBarPageShell =
    '\\.admin-frame\\.has-native-phone-tabbar \\.phone-navigation-page::after'
  assert.match(
    css,
    new RegExp(
      `${phoneTabBarPageShell} \\{ content: ""; display: block;` +
      ' height: var\\(--nessie-native-phone-tabbar-clearance\\); pointer-events: none;\\}',
    ),
  )
  assert.match(
    css,
    new RegExp(
      `${phoneTabBarScrollSurfaces} \\{ padding-bottom: var\\(--nessie-native-phone-tabbar-clearance\\);` +
      ' scroll-padding-bottom: var\\(--nessie-native-phone-tabbar-clearance\\);\\}',
    ),
  )
  assert.doesNotMatch(css, /phone-navigation-page \{ padding-bottom/)
  assert.doesNotMatch(css, /phone-navigation-screen > main/)
  assert.doesNotMatch(css, /touch-sidebar \\{ padding-bottom/)
})

test('iOS phone injection clears only scroll regions that reach the native tab bar', () => {
  const applied = new Map<string, boolean>()
  const scrollerAtBottom = {
    classList: { toggle: (_name: string, enabled: boolean): void => { applied.set('edge', enabled) } },
    getBoundingClientRect: () => ({ bottom: 844, top: 100 }),
  }
  const fixedMenuAtBottom = {
    classList: { toggle: (_name: string, enabled: boolean): void => { applied.set('fixed', enabled) } },
    getBoundingClientRect: () => ({ bottom: 844, top: 200 }),
  }
  const shortPopup = {
    classList: { toggle: (_name: string, enabled: boolean): void => { applied.set('popup', enabled) } },
    getBoundingClientRect: () => ({ bottom: 600, top: 300 }),
  }
  const frame = {
    querySelectorAll: () => [scrollerAtBottom, fixedMenuAtBottom, shortPopup],
  }
  const document = {
    body: {},
    documentElement: {},
    head: { appendChild: (): void => undefined },
    addEventListener: (): void => undefined,
    createElement: (): FakeElement => ({}),
    getElementById: (): null => null,
    querySelector: (selector: string): typeof frame | null =>
      selector === '.admin-frame.has-native-phone-tabbar' ? frame : null,
  }
  const window = {
    __nessieNativeShell: { bottomInset: 34, formFactor: 'phone', platform: 'ios' },
    addEventListener: (): void => undefined,
    innerHeight: 844,
    location: { protocol: 'file:' },
    ReactNativeWebView: { postMessage: (): void => undefined },
  }
  class FakeMutationObserver {
    constructor(_callback: () => void) {}

    observe(): void {}
  }
  const getComputedStyle = (element: unknown): {
    backgroundColor: string
    colorScheme: string
    getPropertyValue: () => string
    overflowY: string
    position: string
  } => ({
    backgroundColor: 'rgb(26, 29, 33)',
    colorScheme: 'light',
    getPropertyValue: () => '',
    overflowY: element === shortPopup ? 'auto' : element === fixedMenuAtBottom ? 'scroll' : 'auto',
    position: element === fixedMenuAtBottom ? 'fixed' : 'static',
  })

  const runInjectedScript = new Function('window', 'document', 'MutationObserver', 'getComputedStyle', INJECTED)
  runInjectedScript(window, document, FakeMutationObserver, getComputedStyle)

  assert.equal(applied.get('edge'), true)
  assert.equal(applied.get('fixed'), false)
  assert.equal(applied.get('popup'), false)
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
  assert.equal(injectedThemeMessage('dark')?.accentStrong, '#5b21b6')
  assert.equal(injectedThemeMessage('dark')?.headerSurface, '#2e1132')
  assert.equal(injectedThemeMessage('dark')?.headerText, '#f8f5ef')
  assert.equal(injectedThemeMessage('dark')?.text, '#f8f5ef')
  assert.equal(injectedThemeMessage('dark')?.textMuted, '#b6b0a9')
  assert.equal(injectedThemeMessage('dark')?.onAccent, '#ffffff')
})

test('uses the iPad page rail for the Sandstone phone header', () => {
  const sandstone = injectedThemeMessage('light', { rail: '#f1e9dc', text: '#2b2018' })

  assert.equal(sandstone?.headerSurface, '#f1e9dc')
  assert.equal(sandstone?.headerText, '#2b2018')
})

test('recognises hexadecimal CSS colours when choosing native contrast', () => {
  assert.deepEqual(parseRgb('#f1e9dc'), [241, 233, 220, 1])
  assert.equal(isDark('#f1e9dc'), false)
  assert.equal(isDark('#2e1132'), true)
})

// Focus mode scopes its palette to the frame's children, so the base theme
// stays on documentElement throughout. These drive the injected script against
// that real shape to prove the native chrome follows focus in and back out.
const BASE_TOKENS: Record<string, string> = {
  '--accent': '#7c3aed',
  '--accent-strong': '#5b21b6',
  '--on-accent': '#ffffff',
  '--panel': '#222629',
  '--rail': '#2e1132',
  '--tx': '#f8f5ef',
  '--tx2': '#b6b0a9',
  '--tx3': '#949597',
}
const FOCUS_SURFACE_TOKENS: Record<string, string> = {
  ...BASE_TOKENS,
  '--accent': '#303030',
  '--accent-strong': '#000000',
  '--panel': '#ffffff',
  '--rail': '#ffffff',
  '--tx': '#1d1d1d',
  '--tx2': '#4d4d4d',
  '--tx3': '#707070',
}
const FOCUS_NAV_TOKENS: Record<string, string> = {
  ...BASE_TOKENS,
  '--accent': '#b9b9bc',
  '--accent-strong': '#ececee',
  '--panel': '#353535',
  '--rail': '#242424',
  '--tx': '#f1f1f1',
  '--tx2': '#d4d4d6',
  '--tx3': '#aeaeaf',
}

const injectedFocusMessages = (
  focusEnabled: boolean,
  // A phone draws no in-page navigation: its header and tab bar are native, so
  // only the work surface carries a focus palette.
  { navChrome: hasNavChrome = true }: { navChrome?: boolean } = {},
): { bg?: Record<string, unknown>; theme?: Record<string, unknown> } => {
  const messages: Record<string, unknown>[] = []
  const navChrome = { tag: 'topbar' }
  const workSurface = { tag: 'shell' }
  const frame = {
    classList: { contains: (name: string): boolean => focusEnabled && name === 'focus-mode' },
    querySelector: (selector: string): unknown => {
      if (selector === ':scope > .admin-topbar') return hasNavChrome ? navChrome : null
      if (selector === ':scope > .admin-shell') return workSurface
      return null
    },
  }
  const body = { tag: 'body' }
  const documentElement = { tag: 'html' }
  const document = {
    body,
    documentElement,
    head: { appendChild: (): void => undefined },
    addEventListener: (): void => undefined,
    createElement: (): FakeElement => ({}),
    getElementById: (): null => null,
    querySelector: (selector: string): unknown =>
      selector === '.admin-frame' ? frame : null,
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
  const getComputedStyle = (element: unknown): {
    backgroundColor: string
    colorScheme: string
    getPropertyValue: (name: string) => string
  } => {
    const tokens = element === navChrome
      ? FOCUS_NAV_TOKENS
      : element === workSurface
        ? FOCUS_SURFACE_TOKENS
        : BASE_TOKENS
    const backgroundColor = element === workSurface
      ? 'rgb(255, 255, 255)'
      : element === body
        ? 'rgb(26, 29, 33)'
        : 'rgba(0, 0, 0, 0)'
    return {
      backgroundColor,
      colorScheme: 'dark',
      getPropertyValue: (name) => tokens[name] ?? '',
    }
  }

  const runInjectedScript = new Function('window', 'document', 'MutationObserver', 'getComputedStyle', INJECTED)
  runInjectedScript(window, document, FakeMutationObserver, getComputedStyle)

  return {
    bg: messages.find((message) => message.type === 'bg'),
    theme: messages.find((message) => message.type === 'theme'),
  }
}

test('focus mode reports the monochrome navigation palette to the native chrome', () => {
  const { theme } = injectedFocusMessages(true)

  assert.equal(theme?.headerSurface, '#242424')
  assert.equal(theme?.surface, '#353535')
  assert.equal(theme?.accent, '#b9b9bc')
  assert.equal(theme?.accentStrong, '#ececee')
  assert.equal(theme?.inactive, '#aeaeaf')
  assert.equal(theme?.headerText, '#f1f1f1')
  assert.equal(theme?.text, '#f1f1f1')
})

test('focus mode backs the native frame with the paper-white work surface', () => {
  assert.equal(injectedFocusMessages(true).bg?.color, 'rgb(255, 255, 255)')
})

// The phone is the form factor the focus palette never reached: its navigation
// is native, so the charcoal in-page chrome the tablet reads simply is not in
// the document. The work surface it does sit against has to drive it instead.
test('a phone with only native navigation still reports a monochrome palette', () => {
  const { theme } = injectedFocusMessages(true, { navChrome: false })

  assert.equal(theme?.headerSurface, '#ffffff')
  assert.equal(theme?.surface, '#ffffff')
  assert.equal(theme?.accent, '#303030')
  assert.equal(theme?.headerText, '#1d1d1d')
  assert.equal(theme?.inactive, '#707070')
})

test('leaving focus mode restores the themed native palette and backdrop', () => {
  const { bg, theme } = injectedFocusMessages(false)

  assert.equal(theme?.headerSurface, '#2e1132')
  assert.equal(theme?.surface, '#222629')
  assert.equal(theme?.accent, '#7c3aed')
  assert.equal(theme?.accentStrong, '#5b21b6')
  assert.equal(theme?.inactive, '#949597')
  assert.equal(theme?.headerText, '#f8f5ef')
  assert.equal(bg?.color, 'rgb(26, 29, 33)')
})
