import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mountPhoneNavigationViewport as mount,
  type PhoneNavigationViewportHarness as Harness,
} from './support/phone-navigation-viewport-harness'

// Behavioural coverage for the phone's live route stack: forward preparation,
// retained-screen identity, and the interactive edge Back lifecycle.
const drag = (
  harness: Harness,
  moves: Array<readonly [number, number]>,
  end: 'touchend' | 'touchcancel' = 'touchend',
  target?: Element | null,
) => {
  const [start, ...rest] = moves
  assert.ok(start, 'drag needs a start point')
  harness.touch('touchstart', start[0], start[1], target)
  for (const [x, y] of rest) harness.touch('touchmove', x, y)
  const last = moves[moves.length - 1]
  assert.ok(last, 'drag needs an end point')
  harness.touch(end, last[0], last[1])
}

// A committed swipe ends with a flick: the release lands ~16ms after the
// last tracked move, so the tail velocity clears the commit threshold.
const flick = (
  harness: Harness,
  moves: Array<readonly [number, number]>,
) => {
  const [start, ...rest] = moves
  assert.ok(start, 'drag needs a start point')
  harness.touch('touchstart', start[0], start[1])
  for (const [x, y] of rest) harness.touch('touchmove', x, y)
  const last = moves[moves.length - 1]
  assert.ok(last, 'flick needs an end point')
  harness.touch('touchend', last[0], last[1], undefined, 16)
}

// A WAAPI settle never finishes under jsdom (no animation timeline), so the
// hook's fallback timer closes the lane: 220ms settle + 180ms slack.
const SETTLE_FALLBACK_MS = 500

test('every phone screen carries the shared page scroll shell', async () => {
  const harness = await mount('/channels')
  const current = harness.layer('current')

  assert.ok(current)
  const page = current.querySelector('[data-phone-navigation-page]')
  assert.ok(page, 'the page shell owns end clearance for full-height screens')
  assert.equal(page?.textContent, 'screen:/channels@/channels')

  await harness.goTo('/channels/channel_a')
  assert.ok(
    harness.layer('incoming')?.querySelector('[data-phone-navigation-page]'),
    'a destination receives the same shell before its transition starts',
  )
  await harness.unmount()
})

test('a forward push paints the mounted destination offscreen before motion starts', async () => {
  const harness = await mount('/channels')
  await harness.goTo('/channels/channel_a', false)

  const viewport = harness.container.querySelector('[data-phone-navigation-viewport]')
  assert.equal(viewport?.getAttribute('data-phone-navigation-phase'), 'preparing')
  assert.match(
    harness.layer('incoming')?.className ?? '',
    /phone-navigation-screen--forward-ready/,
  )
  assert.match(
    harness.layer('outgoing')?.className ?? '',
    /phone-navigation-screen--forward-source-ready/,
  )
  assert.equal(
    harness.layer('incoming')?.textContent,
    'screen:/channels/channel_a@/channels/channel_a',
    'the real destination DOM is ready before its first moving frame',
  )
  assert.equal(
    harness.layer('outgoing')?.textContent,
    'screen:/channels@/channels',
    'the previous screen remains painted while the destination is prepared',
  )

  await harness.paintFrame()
  assert.equal(
    viewport?.getAttribute('data-phone-navigation-phase'),
    'preparing',
    'one complete paint boundary separates mount from motion',
  )

  await harness.paintFrame()
  assert.equal(viewport?.getAttribute('data-phone-navigation-phase'), 'running')
  assert.match(
    harness.layer('incoming')?.className ?? '',
    /phone-navigation-screen--forward-in/,
  )
  assert.match(
    harness.layer('outgoing')?.className ?? '',
    /phone-navigation-screen--forward-out/,
  )
  await harness.unmount()
})

test('the exact root instance stays mounted as the live underlay from root to detail', async () => {
  const harness = await mount('/channels')
  assert.equal(harness.layer('current')?.dataset.phoneNavigationRoute, 'root:channels:/channels')
  assert.equal(harness.layer('underlay'), null, 'a root owns the only layer')

  await harness.goTo('/channels/channel_a')
  // Programmatic forward runs the paired keyframe transition between the two
  // live layers — the outgoing root is real DOM, not a snapshot.
  assert.equal(harness.layer('outgoing')?.dataset.phoneNavigationRoute, 'root:channels:/channels')
  assert.equal(harness.layer('incoming')?.dataset.phoneNavigationRoute, 'channels:channel')

  await harness.flush(450) // past the transition fallback timer
  const underlay = harness.layer('underlay')
  assert.ok(underlay, 'root retained live under the detail')
  assert.equal(underlay.dataset.phoneNavigationRoute, 'root:channels:/channels')
  assert.equal(underlay.getAttribute('aria-hidden'), 'true')
  assert.deepEqual(harness.mounts(), { 'channels-root': 1, 'channels-detail': 1 })
  assert.equal(underlay.textContent, 'screen:/channels@/channels')

  const rootContent = underlay.querySelector('[data-screen-label]')
  assert.ok(rootContent instanceof HTMLElement)
  Object.defineProperty(rootContent, 'scrollTop', { configurable: true, value: 240 })
  assert.equal(rootContent.scrollTop, 240)

  await harness.unmount()
})

test('an edge drag exposes the live underlay and the detail follows the finger', async () => {
  const harness = await mount('/channels')
  await harness.goTo('/channels/channel_a')
  await harness.flush(450)
  const underlay = harness.layer('underlay')
  assert.ok(underlay, 'root underlay mounted')

  harness.touch('touchstart', 6, 300)
  harness.touch('touchmove', 60, 302)
  harness.touch('touchmove', 150, 303)
  const detail = harness.layer('current')
  assert.match(detail?.style.transform ?? '', /translate3d\(3[0-9]\.\d+%/, 'detail follows the finger')
  assert.match(underlay.style.transform, /translate3d\(-1[0-9]\.\d+%/, 'root parallax follows')
  assert.equal(underlay.textContent, 'screen:/channels@/channels')
  assert.deepEqual(harness.mounts(), { 'channels-root': 1, 'channels-detail': 1 })

  harness.touch('touchend', 150, 303)
  await harness.flush(SETTLE_FALLBACK_MS)
  assert.equal(
    harness.currentPathname()?.dataset.screenLabel,
    '/channels/channel_a',
    'a short drag cancels: route and current layer unchanged',
  )
  assert.equal(harness.layer('current')?.style.transform ?? '', '', 'no residual transform')
  await harness.unmount()
})

test('a commit keeps the route on the detail through the settle, then updates it exactly once', async () => {
  const harness = await mount('/channels')
  await harness.goTo('/channels/channel_a')
  await harness.flush(450)

  flick(harness, [[6, 300], [120, 302], [260, 303], [330, 304]])

  await harness.flush(20)
  assert.equal(harness.locationLabel(), '/channels/channel_a', 'still detail during settle')
  assert.equal(
    harness.layer('current')?.dataset.phoneNavigationRoute,
    'channels:channel',
    'the detail remains the current layer while the settle runs',
  )
  assert.equal(harness.layer('incoming'), null, 'no route animation during the settle')
  assert.equal(harness.layer('outgoing'), null)

  await harness.flush(SETTLE_FALLBACK_MS)
  assert.equal(harness.locationLabel(), '/channels', 'route became root only after the settle')

  await harness.flush(1000)
  const current = harness.layer('current')
  assert.equal(current?.dataset.phoneNavigationRoute, 'root:channels:/channels')
  assert.equal(current?.style.transform ?? '', '', 'no residual transform')
  assert.equal(harness.layer('underlay'), null, 'a root shows no underlay')
  assert.equal(harness.layer('incoming'), null, 'the pop animation must not replay')
  assert.equal(harness.layer('outgoing'), null, 'no outgoing layer replays')
  assert.deepEqual(harness.mounts(), { 'channels-root': 1, 'channels-detail': 0 })
  await harness.unmount()
})

test('a committed swipe pops history once and never leaves the departed detail behind', async () => {
  const harness = await mount('/channels')
  await harness.goTo('/channels/channel_a')
  await harness.flush(450)

  flick(harness, [[6, 300], [120, 302], [260, 303], [330, 304]])
  await harness.flush(SETTLE_FALLBACK_MS)
  assert.equal(harness.locationLabel(), '/channels')

  await harness.historyBack()
  assert.equal(
    harness.locationLabel(),
    '/outside',
    'the next Back crosses the root instead of reopening the departed detail',
  )
  await harness.unmount()
})

test('a route transition owns input until it settles, then edge Back is available', async () => {
  const harness = await mount('/channels')
  await harness.goTo('/channels/channel_a')
  // A push in flight owns the two visible layers, so a competing gesture is
  // ignored instead of mixing CSS animation and finger-driven transforms.
  flick(harness, [[6, 300], [200, 301], [340, 302]])
  await harness.flush(450)
  assert.equal(harness.locationLabel(), '/channels/channel_a')
  assert.equal(harness.layer('incoming'), null)
  assert.equal(harness.layer('outgoing'), null)

  flick(harness, [[6, 300], [200, 301], [340, 302]])
  await harness.flush(SETTLE_FALLBACK_MS)
  assert.equal(harness.locationLabel(), '/channels')
  assert.equal(
    harness.layer('current')?.dataset.phoneNavigationRoute,
    'root:channels:/channels',
  )
  assert.deepEqual(harness.mounts(), { 'channels-root': 1, 'channels-detail': 0 })
  await harness.unmount()
})

test('vertical scrolls, non-edge touches, and text editing never arm the gesture', async () => {
  const harness = await mount('/channels')
  await harness.goTo('/channels/channel_a')
  await harness.flush(450)

  drag(harness, [[6, 100], [8, 180], [10, 260]])
  await harness.flush()
  assert.equal(harness.locationLabel(), '/channels/channel_a')
  assert.equal(harness.layer('current')?.style.transform ?? '', '')

  drag(harness, [[120, 300], [260, 301], [380, 302]])
  await harness.flush()
  assert.equal(harness.locationLabel(), '/channels/channel_a')

  const input = document.createElement('input')
  harness.layer('current')?.appendChild(input)
  drag(harness, [[6, 300], [200, 301], [340, 302]], 'touchend', input)
  await harness.flush(SETTLE_FALLBACK_MS)
  assert.equal(harness.locationLabel(), '/channels/channel_a')
  await harness.unmount()
})

test('opted-out and horizontally scrollable ancestors keep their horizontal drags', async () => {
  const harness = await mount('/channels')
  await harness.goTo('/channels/channel_a')
  await harness.flush(450)
  const current = harness.layer('current')
  assert.ok(current)

  const optedOut = document.createElement('div')
  optedOut.setAttribute('data-phone-back-swipe-ignore', '')
  current.appendChild(optedOut)
  drag(harness, [[6, 300], [200, 301], [340, 302]], 'touchend', optedOut)
  await harness.flush(SETTLE_FALLBACK_MS)
  assert.equal(harness.locationLabel(), '/channels/channel_a')
  assert.equal(harness.layer('current')?.style.transform ?? '', '')

  const carousel = document.createElement('div')
  carousel.style.overflowX = 'auto'
  Object.defineProperty(carousel, 'scrollWidth', { configurable: true, value: 800 })
  Object.defineProperty(carousel, 'clientWidth', { configurable: true, value: 390 })
  current.appendChild(carousel)
  drag(harness, [[6, 300], [200, 301], [340, 302]], 'touchend', carousel)
  await harness.flush(SETTLE_FALLBACK_MS)
  assert.equal(harness.locationLabel(), '/channels/channel_a')
  await harness.unmount()
})

test('a leftward reversal past the hysteresis keeps the detail', async () => {
  const harness = await mount('/channels')
  await harness.goTo('/channels/channel_a')
  await harness.flush(450)

  harness.touch('touchstart', 6, 300)
  harness.touch('touchmove', 300, 301)
  harness.touch('touchmove', 280, 302)
  harness.touch('touchmove', 260, 302)
  harness.touch('touchmove', 240, 302)
  harness.touch('touchend', 240, 302, undefined, 30)
  await harness.flush(SETTLE_FALLBACK_MS)
  assert.equal(harness.locationLabel(), '/channels/channel_a', 'reversal cancels the commit')
  assert.equal(harness.layer('current')?.style.transform ?? '', '')
  assert.deepEqual(harness.mounts(), { 'channels-root': 1, 'channels-detail': 1 })
  await harness.unmount()
})

test('touchcancel during a claimed drag restores the detail without navigating', async () => {
  const harness = await mount('/channels')
  await harness.goTo('/channels/channel_a')
  await harness.flush(450)
  harness.touch('touchstart', 6, 300)
  harness.touch('touchmove', 220, 301)
  harness.touch('touchcancel', 220, 301)
  await harness.flush(SETTLE_FALLBACK_MS)
  assert.equal(harness.locationLabel(), '/channels/channel_a')
  assert.equal(harness.layer('current')?.style.transform ?? '', '', 'no residual transform after cancel')
  assert.deepEqual(harness.mounts(), { 'channels-root': 1, 'channels-detail': 1 })
  await harness.unmount()
})
