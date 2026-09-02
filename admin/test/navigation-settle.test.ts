import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import {
  ANNOUNCER_ATTRIBUTE,
  announceScreen,
  blurBeforePush,
  layerHoldsFocus,
  settleFocus,
} from '../src/navigation/settle'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const dom = () => {
  const { window } = new JSDOM(`<!doctype html><html><body>
    <div id="viewport">
      <div data-phone-navigation-layer="incoming"><h1>Design Review</h1><input id="field" /></div>
      <div data-phone-navigation-layer="outgoing"><button id="btn">x</button></div>
    </div>
    <div ${ANNOUNCER_ATTRIBUTE}="" aria-live="polite"></div>
  </body></html>`, { pretendToBeVisual: true })
  return window
}

test('a push focuses the landed heading without scrolling; a pop only if the leaving screen held focus', () => {
  const window = dom()
  const top = window.document.querySelector('[data-phone-navigation-layer="incoming"]')
  const heading = top?.querySelector('h1') as HTMLElement
  let scrolled: unknown = 'unset'
  heading.focus = ((options?: FocusOptions) => { scrolled = options?.preventScroll }) as typeof heading.focus
  assert.equal(settleFocus({ direction: 'forward', top, outgoingHadFocus: false }), true)
  assert.equal(scrolled, true, 'focus never scrolls a clipped container')
  assert.equal(heading.getAttribute('tabindex'), '-1')
  scrolled = 'unset'
  assert.equal(settleFocus({ direction: 'back', top, outgoingHadFocus: false }), false)
  assert.equal(scrolled, 'unset', 'a pop leaves focus alone unless the popped screen held it')
  assert.equal(settleFocus({ direction: 'back', top, outgoingHadFocus: true }), true)
})

test('focus ownership is decided by containment, and a push blurs the active element', () => {
  const window = dom()
  const outgoing = window.document.querySelector('[data-phone-navigation-layer="outgoing"]')
  const button = window.document.getElementById('btn')
  assert.equal(layerHoldsFocus(outgoing, button), true)
  assert.equal(layerHoldsFocus(outgoing, window.document.body), false)
  let blurred = false
  const previous = globalThis.document
  Object.defineProperty(globalThis, 'document', { configurable: true, value: window.document })
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: window.HTMLElement })
  try {
    ;(button as HTMLElement).blur = () => { blurred = true }
    blurBeforePush(button)
    assert.equal(blurred, true)
    blurBeforePush(window.document.body)
  } finally {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previous })
  }
})

test('the settled heading is announced once through the one live region, debounced', async () => {
  const window = dom()
  const top = window.document.querySelector('[data-phone-navigation-layer="incoming"]')
  announceScreen(top, window.document)
  announceScreen(top, window.document)
  const region = window.document.querySelector(`[${ANNOUNCER_ATTRIBUTE}]`)
  assert.equal(region?.textContent, '')
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(region?.textContent, 'Design Review')
})

test('the stack settles after the slide, the provider hosts the live region, and the root owns scroll restoration', () => {
  const viewport = source('../src/layouts/admin-shell/PhoneNavigationViewport.tsx')
  const finish = viewport.slice(viewport.indexOf('const finishTransition = useCallback('), viewport.indexOf('const startTransition = useCallback('))
  assert.match(finish, /settleFocus\(/)
  assert.match(finish, /announceScreen\(/)
  const start = viewport.slice(viewport.indexOf('const startTransition = useCallback('), viewport.indexOf('// Route children are captured'))
  assert.match(start, /blurBeforePush\(/)
  assert.match(source('../src/layouts/admin-shell/PhoneNavigationProvider.tsx'), /aria-live="polite"[\s\S]*ANNOUNCER_ATTRIBUTE/)
  assert.match(source('../src/main.tsx'), /scrollRestoration = 'manual'/)
})
