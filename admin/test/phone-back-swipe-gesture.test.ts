import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import {
  isPhoneBackSwipeClaimableTarget,
  isPhoneBackSwipeHorizontal,
  isPhoneBackSwipeVertical,
  phoneBackSwipeVelocity,
  resolvePhoneBackSwipeOutcome,
} from '../src/layouts/admin-shell/phone-navigation-gesture'

test('claims only unambiguous horizontal drags', () => {
  assert.equal(isPhoneBackSwipeHorizontal(12, 2), true)
  assert.equal(isPhoneBackSwipeHorizontal(12, 12), false)
  assert.equal(isPhoneBackSwipeHorizontal(4, 1), false, 'below the slop')
  assert.equal(isPhoneBackSwipeHorizontal(-12, 2), true, 'magnitude only')
})

test('leaves vertical scrolls to the scroller', () => {
  assert.equal(isPhoneBackSwipeVertical(3, 20), true)
  assert.equal(isPhoneBackSwipeVertical(20, 3), false)
  assert.equal(isPhoneBackSwipeVertical(9, 9), false)
})

test('estimates release velocity from the tail of the gesture', () => {
  const velocity = phoneBackSwipeVelocity([
    { clientX: 8, clientY: 100, time: 0 },
    { clientX: 60, clientY: 101, time: 400 },
    { clientX: 90, clientY: 102, time: 440 },
    { clientX: 150, clientY: 103, time: 480 },
  ])
  // Only the last 100ms count: (150 - 60) / 80.
  assert.ok(Math.abs(velocity - 90 / 80) < 1e-9, `got ${velocity}`)
  assert.equal(phoneBackSwipeVelocity([]), 0)
  assert.equal(
    phoneBackSwipeVelocity([{ clientX: 8, clientY: 100, time: 0 }]),
    0,
  )
})

test('commits past the distance threshold', () => {
  assert.equal(
    resolvePhoneBackSwipeOutcome({ progress: 0.5, velocity: 0 }),
    'commit',
  )
  assert.equal(
    resolvePhoneBackSwipeOutcome({ progress: 0.41, velocity: 0 }),
    'cancel',
  )
})

test('commits on a flick only after meaningful travel', () => {
  assert.equal(
    resolvePhoneBackSwipeOutcome({ progress: 0.2, velocity: 1.2 }),
    'commit',
  )
  assert.equal(
    resolvePhoneBackSwipeOutcome({ progress: 0.05, velocity: 2 }),
    'cancel',
    'a tiny horizontal nudge on an edge-resting control must not navigate',
  )
})

test('cancels a slow short drag and a stationary release', () => {
  assert.equal(
    resolvePhoneBackSwipeOutcome({ progress: 0.3, velocity: 0.1 }),
    'cancel',
  )
  assert.equal(
    resolvePhoneBackSwipeOutcome({ progress: 0, velocity: 5 }),
    'cancel',
  )
})

// Reduced motion removes only the settle duration (handled in the hook and
// CSS); the release decision uses exactly the same distance/velocity
// thresholds, so a faint touch must not navigate just because motion is
// reduced.
test('the release decision carries no reduced-motion special case', () => {
  assert.equal(
    resolvePhoneBackSwipeOutcome({ progress: 0.02, velocity: 0 }),
    'cancel',
  )
})

test('excludes editing surfaces, opt-out ancestors, and horizontal scrollers', () => {
  const dom = new JSDOM('<!doctype html><body></body>')
  const { document, Element, getComputedStyle } = dom.window
  const restore = [
    ['Element', globalThis.Element],
    ['getComputedStyle', globalThis.getComputedStyle],
  ] as const
  Object.defineProperty(globalThis, 'Element', { configurable: true, value: Element })
  Object.defineProperty(globalThis, 'getComputedStyle', {
    configurable: true,
    value: getComputedStyle.bind(dom.window),
  })
  try {
    const host = document.createElement('div')
    document.body.appendChild(host)

    const input = document.createElement('input')
    host.appendChild(input)
    assert.equal(isPhoneBackSwipeClaimableTarget(input), false, 'text editing owns its drags')

    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    host.appendChild(editable)
    assert.equal(isPhoneBackSwipeClaimableTarget(editable), false)

    const optedOut = document.createElement('div')
    optedOut.setAttribute('data-phone-back-swipe-ignore', '')
    const optedChild = document.createElement('button')
    optedOut.appendChild(optedChild)
    host.appendChild(optedOut)
    assert.equal(isPhoneBackSwipeClaimableTarget(optedChild), false, 'explicit opt-out ancestor')

    const carousel = document.createElement('div')
    carousel.style.overflowX = 'auto'
    Object.defineProperty(carousel, 'scrollWidth', { configurable: true, value: 800 })
    Object.defineProperty(carousel, 'clientWidth', { configurable: true, value: 390 })
    const carouselChild = document.createElement('div')
    carousel.appendChild(carouselChild)
    host.appendChild(carousel)
    assert.equal(isPhoneBackSwipeClaimableTarget(carouselChild), false, 'horizontal scroller keeps its pans')

    const plain = document.createElement('div')
    host.appendChild(plain)
    assert.equal(isPhoneBackSwipeClaimableTarget(plain), true)
    assert.equal(isPhoneBackSwipeClaimableTarget(null), true)
  } finally {
    for (const [key, value] of restore) {
      Object.defineProperty(globalThis, key, { configurable: true, value })
    }
  }
})
