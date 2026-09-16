import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html data-theme="nessie"><head></head><body></body></html>', {
  pretendToBeVisual: true,
  url: 'https://app.nessie.example/channels',
})

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { NativeChromeThemeBridge, REPOST_AFTER_LEGACY_SETTLE_MS } = await import(
  '../src/bridges/NativeChromeThemeBridge.js'
)

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

// jsdom does not cascade custom properties out of a stylesheet, so the test
// answers getComputedStyle directly: the palette element carries the chrome's
// tokens, the document the work surface's — the split that made the header white.
const CHROME: Record<string, string> = {
  '--accent': '#2f80ed',
  '--main': '#13223b',
  '--panel': '#13223b',
  '--rail': '#0b172a',
  '--tx': '#ffffff',
}
const SURFACE: Record<string, string> = {
  '--accent': '#1f6feb',
  '--main': '#ffffff',
  '--panel': '#ffffff',
  '--rail': '#eef2f8',
  '--tx': '#0b172a',
}

const fakeComputedStyle = (element: Element) => {
  const chrome = element.classList?.contains('native-chrome-palette') ?? false
  const tokens = chrome ? CHROME : SURFACE
  return {
    backgroundColor: element === dom.window.document.body ? 'rgb(238, 242, 248)' : 'rgba(0, 0, 0, 0)',
    colorScheme: chrome ? 'dark' : 'light',
    getPropertyValue: (name: string) => tokens[name] ?? '',
  }
}

type Message = Record<string, unknown>
const messages: Message[] = []
const shellWindow = dom.window as unknown as Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
  __nessieChromeThemePublisher?: boolean
  __nessieNativeShell?: { formFactor: string; platform: string }
}
shellWindow.ReactNativeWebView = { postMessage: (data) => { messages.push(JSON.parse(data) as Message) } }
shellWindow.__nessieNativeShell = { formFactor: 'phone', platform: 'ios' }

// The admin suite runs every file in one process, so the DOM globals are
// installed per test and restored after it, never left behind at import.
const installDom = () => {
  const values = {
    document: dom.window.document,
    Element: dom.window.Element,
    getComputedStyle: fakeComputedStyle,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: dom.window.MutationObserver,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    window: dom.window,
  }
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

const wait = (ms: number) => act(async () => {
  await new Promise((resolve) => dom.window.setTimeout(resolve, ms))
})
const themes = () => messages.filter((message) => message.type === 'theme')
const backdrops = () => messages.filter((message) => message.type === 'bg')

const mountFrame = async () => {
  const frame = dom.window.document.createElement('div')
  frame.className = 'admin-frame'
  dom.window.document.body.appendChild(frame)
  const root = createRoot(frame)
  await act(async () => { root.render(h(NativeChromeThemeBridge)) })
  return { frame, root }
}

test('the shell publishes the chrome palette, re-posts past the legacy settle, and hands back on sign-out', async () => {
  const restore = installDom()
  try {
    messages.length = 0
    const { frame, root } = await mountFrame()

    assert.equal(shellWindow.__nessieChromeThemePublisher, true)
    assert.equal(themes().at(-1)?.chromeSource, 'page')
    assert.equal(themes().at(-1)?.headerSurface, '#0b172a')
    assert.equal(themes().at(-1)?.headerText, '#ffffff')
    // An iPhone backdrop is the chrome's --main.
    assert.equal(backdrops().at(-1)?.color, '#13223b')

    // An installed shell re-posts the root palette for 600ms after a change;
    // the bridge must speak last.
    messages.length = 0
    await wait(REPOST_AFTER_LEGACY_SETTLE_MS + 50)
    assert.ok(REPOST_AFTER_LEGACY_SETTLE_MS > 600)
    assert.equal(themes().at(-1)?.headerSurface, '#0b172a')

    // Focus mode is a class on the frame.
    messages.length = 0
    await act(async () => { frame.classList.add('focus-mode') })
    await wait(0)
    assert.ok(themes().length > 0, 'a focus toggle posts the palette again')

    // A route's <title> changing is not a palette change.
    messages.length = 0
    await act(async () => {
      dom.window.document.head.appendChild(dom.window.document.createElement('title')).textContent = 'Channel'
    })
    await wait(0)
    assert.equal(themes().length, 0)

    messages.length = 0
    await act(async () => { root.unmount() })
    assert.equal(shellWindow.__nessieChromeThemePublisher, undefined)
    await wait(20)
    const handedBack = themes().at(-1)
    assert.ok(handedBack, 'unmounting hands the document palette back')
    assert.equal(handedBack.chromeSource, undefined)
    assert.equal(handedBack.headerSurface, '#eef2f8')
    assert.equal(backdrops().at(-1)?.color, 'rgb(238, 242, 248)')
    frame.remove()
  } finally {
    restore()
  }
})

test('a bridge that remounts at once keeps ownership without handing back', async () => {
  const restore = installDom()
  try {
    const first = await mountFrame()
    messages.length = 0
    await act(async () => {
      first.root.unmount()
      first.root = createRoot(first.frame)
      first.root.render(h(NativeChromeThemeBridge))
    })
    await wait(20)
    assert.equal(shellWindow.__nessieChromeThemePublisher, true)
    assert.equal(themes().some((message) => message.chromeSource === undefined), false)
    await act(async () => { first.root.unmount() })
    await wait(20)
    first.frame.remove()
  } finally {
    restore()
  }
})

// Removing this mount would bring back the white native header with every
// other test still green.
test('the admin shell mounts the bridge as a direct child of the frame, inside the native shell only', () => {
  const layout = readFileSync(
    fileURLToPath(new URL('../src/layouts/AdminShellLayout.tsx', import.meta.url)),
    'utf8',
  )
  assert.match(
    layout,
    /<div className=\{frameClassName\}[^>]*>\s*\{nativeShell \? <NativeChromeThemeBridge \/> : null\}/,
  )
})
