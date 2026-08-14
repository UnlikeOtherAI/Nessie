import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import test from 'node:test'

// Behavioural coverage for the phone's interactive back-swipe: the section
// root must stay mounted (same component instance, scroll intact) as the
// live underlay during a drag, a commit must land as exactly one route
// update after the settle with no replayed animation, and cancellation must
// leave route and DOM untouched. Rendering runs against jsdom because the
// interaction is transform/state driven, not paint driven. JSX is avoided so
// the admin's `test/**/*.test.ts` discovery picks this file up.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/channels',
  pretendToBeVisual: true,
})

for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Touch: dom.window.Touch,
  TouchEvent: dom.window.TouchEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: clearTimeout,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
}

dom.window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  onchange: null,
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia

Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get: () => 390,
})

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { MemoryRouter, useLocation, useNavigate } = await import('react-router-dom')
const { PhoneNavigationViewport } = await import(
  '../src/layouts/admin-shell/PhoneNavigationViewport'
)

type Harness = {
  container: HTMLElement
  currentPathname: () => HTMLElement | null
  flush: (ms?: number) => Promise<void>
  goTo: (pathname: string) => Promise<void>
  layer: (name: string) => HTMLElement | null
  locationLabel: () => string
  mounts: () => Record<string, number>
  scrollTops: () => Record<string, number>
  touch: (type: string, x: number, y: number, target?: Element | null) => void
  unmount: () => Promise<void>
}

// One component type renders every route, so its mount/unmount counts prove
// which instances survive each navigation. The shell re-renders the viewport
// with the routed pathname on every location change; the host reproduces
// that subscription.
const mount = async (initialPathname: string): Promise<Harness> => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let pathname = initialPathname
  let navigateTo: ((pathname: string) => void) | null = null
  const mounts: Record<string, number> = {}
  const scrollTops: Record<string, number> = {}

  const Screen = ({ label }: { label: string }) => {
    const location = useLocation()
    return h('div', {
      'data-screen-label': label,
      ref: (node: HTMLElement | null) => {
        if (node) scrollTops[label] = node.scrollTop
      },
    }, `screen:${label}@${location.pathname}`)
  }

  // The identity probe: the root and the detail are different component
  // types, so a mount count of 1 for each proves the exact instances survive
  // every navigation — 0-and-remounted would mean recreation.
  const ScreenForPath = ({ path }: { path: string }) =>
    path === '/channels' ? h(ChannelsRoot) : h(ChannelsDetail)
  const ChannelsRoot = () => {
    React.useEffect(() => {
      mounts['channels-root'] = (mounts['channels-root'] ?? 0) + 1
      return () => {
        mounts['channels-root'] = (mounts['channels-root'] ?? 1) - 1
      }
    }, [])
    return h(Screen, { label: '/channels' })
  }
  const ChannelsDetail = () => {
    React.useEffect(() => {
      mounts['channels-detail'] = (mounts['channels-detail'] ?? 0) + 1
      return () => {
        mounts['channels-detail'] = (mounts['channels-detail'] ?? 1) - 1
      }
    }, [])
    return h(Screen, { label: '/channels/channel_a' })
  }

  const Host = () => {
    const location = useLocation()
    const navigate = useNavigate()
    pathname = location.pathname
    navigateTo = (next: string) => navigate(next)
    return h(
      PhoneNavigationViewport,
      { pathname: location.pathname },
      h(ScreenForPath, { path: location.pathname }),
    )
  }

  const root = createRoot(container)
  const flush = async (ms = 0) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms))
    })
  }

  await act(async () => {
    root.render(
      h(MemoryRouter, { initialEntries: [initialPathname] }, h(Host)),
    )
  })
  await flush()

  let eventClock = 1000
  const touch = (
    type: string,
    x: number,
    y: number,
    target?: Element | null,
    dt?: number,
  ) => {
    const viewport = container.querySelector('[data-phone-navigation-viewport]')
    assert.ok(viewport, 'viewport mounted')
    // Synthetic event times feed the release-velocity window: touchend is
    // stamped 400ms after the last move so an ordinary drag reads a
    // stationary release; the flick commits below stamp their own fast tail.
    eventClock += dt ?? (type === 'touchend' ? 400 : 16)
    const touches = [{
      identifier: 1,
      clientX: x,
      clientY: y,
      target: viewport,
    }] as unknown as Touch[] & TouchList
    const ended = type === 'touchend' || type === 'touchcancel'
    const event = new dom.window.TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      changedTouches: touches,
      targetTouches: ended ? [] : touches,
      touches: ended ? [] : touches,
    })
    Object.defineProperty(event, 'timeStamp', { value: eventClock })
    act(() => {
      ;(target ?? viewport).dispatchEvent(event)
    })
  }

  return {
    container,
    currentPathname: () =>
      container.querySelector(
        '[data-phone-navigation-layer="current"] [data-screen-label]',
      ),
    flush,
    goTo: async (next: string) => {
      assert.ok(navigateTo, 'router ready')
      await act(async () => {
        navigateTo(next)
      })
      await flush()
    },
    layer: (name) => container.querySelector(`[data-phone-navigation-layer="${name}"]`),
    locationLabel: () => pathname,
    mounts: () => ({ ...mounts }),
    scrollTops: () => ({ ...scrollTops }),
    touch,
    unmount: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

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

test.afterEach(() => {
  document.body.innerHTML = ''
})

test('the exact root instance stays mounted as the live underlay from root to detail', async () => {
  const harness = await mount('/channels')
  assert.equal(harness.layer('current')?.dataset.phoneNavigationRoute, 'channels:root')
  assert.equal(harness.layer('underlay'), null, 'a root owns the only layer')

  await harness.goTo('/channels/channel_a')
  // Programmatic forward runs the paired keyframe transition between the two
  // live layers — the outgoing root is real DOM, not a snapshot.
  assert.equal(harness.layer('outgoing')?.dataset.phoneNavigationRoute, 'channels:root')
  assert.equal(harness.layer('incoming')?.dataset.phoneNavigationRoute, 'channels:channel:channel_a')

  await harness.flush(450) // past the transition fallback timer
  const underlay = harness.layer('underlay')
  assert.ok(underlay, 'root retained live under the detail')
  assert.equal(underlay.dataset.phoneNavigationRoute, 'channels:root')
  assert.equal(underlay.getAttribute('aria-hidden'), 'true')

  // The identity proof: the /channels component instance mounted once, at
  // the initial root render, and was never unmounted across the forward
  // animation or the detail idle — it is the same instance now revealed as
  // the underlay, not a recreated element.
  assert.deepEqual(harness.mounts(), { 'channels-root': 1, 'channels-detail': 1 })
  assert.equal(underlay.textContent, 'screen:/channels@/channels')

  // The retained root keeps its own DOM state (scroll position here) while
  // hidden beneath the detail.
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
  // Live content, mid-drag: the underlay is the running root instance.
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

  // During the settle the route is still the detail.
  await harness.flush(20)
  assert.equal(harness.locationLabel(), '/channels/channel_a', 'still detail during settle')
  assert.equal(
    harness.layer('current')?.dataset.phoneNavigationRoute,
    'channels:channel:channel_a',
    'the detail remains the current layer while the settle runs',
  )
  assert.equal(harness.layer('incoming'), null, 'no route animation during the settle')
  assert.equal(harness.layer('outgoing'), null)

  await harness.flush(SETTLE_FALLBACK_MS)
  assert.equal(harness.locationLabel(), '/channels', 'route became root only after the settle')

  await harness.flush(1000)
  const current = harness.layer('current')
  assert.equal(current?.dataset.phoneNavigationRoute, 'channels:root')
  assert.equal(current?.style.transform ?? '', '', 'no residual transform')
  assert.equal(harness.layer('underlay'), null, 'a root shows no underlay')
  assert.equal(harness.layer('incoming'), null, 'the pop animation must not replay')
  assert.equal(harness.layer('outgoing'), null, 'no outgoing layer replays')
  // The root instance is still the same one — mounted once, never remounted.
  assert.deepEqual(harness.mounts(), { 'channels-root': 1, 'channels-detail': 0 })
  await harness.unmount()
})

test('a rapid tap-forward then immediate swipe-back never double-animates', async () => {
  const harness = await mount('/channels')
  await harness.goTo('/channels/channel_a')
  // Do NOT wait out the 300ms keyframe transition: swipe back immediately,
  // while the outgoing/incoming pair would still be on screen.
  flick(harness, [[6, 300], [200, 301], [340, 302]])
  await harness.flush()
  assert.equal(harness.locationLabel(), '/channels/channel_a', 'route still detail during settle')

  await harness.flush(SETTLE_FALLBACK_MS)
  assert.equal(harness.locationLabel(), '/channels')
  await harness.flush(1000)
  assert.equal(harness.layer('incoming'), null, 'leftover forward transition dropped')
  assert.equal(harness.layer('outgoing'), null)
  assert.equal(harness.layer('current')?.dataset.phoneNavigationRoute, 'channels:root')
  assert.deepEqual(harness.mounts(), { 'channels-root': 1, 'channels-detail': 0 })
  await harness.unmount()
})

test('vertical scrolls, non-edge touches, and text editing never arm the gesture', async () => {
  const harness = await mount('/channels')
  await harness.goTo('/channels/channel_a')
  await harness.flush(450)

  // Steep vertical start: the gesture yields to the scroller.
  drag(harness, [[6, 100], [8, 180], [10, 260]])
  await harness.flush()
  assert.equal(harness.locationLabel(), '/channels/channel_a')
  assert.equal(harness.layer('current')?.style.transform ?? '', '')

  // A touch starting away from the edge is ordinary content interaction.
  drag(harness, [[120, 300], [260, 301], [380, 302]])
  await harness.flush()
  assert.equal(harness.locationLabel(), '/channels/channel_a')

  // A touch beginning inside a text input is editing, not navigation.
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

  // Explicit opt-out: a marked ancestor disables the gesture inside it.
  const optedOut = document.createElement('div')
  optedOut.setAttribute('data-phone-back-swipe-ignore', '')
  current.appendChild(optedOut)
  drag(harness, [[6, 300], [200, 301], [340, 302]], 'touchend', optedOut)
  await harness.flush(SETTLE_FALLBACK_MS)
  assert.equal(harness.locationLabel(), '/channels/channel_a')
  assert.equal(harness.layer('current')?.style.transform ?? '', '')

  // A horizontally scrollable ancestor (a carousel) keeps its pans.
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

  // Pull past the commit ratio, then drag back left beyond the hysteresis.
  // The tail samples sit within the 100ms velocity window so the release
  // reads a leftward flick rather than the earlier rightward pull.
  harness.touch('touchstart', 6, 300)
  harness.touch('touchmove', 300, 301) // progress ~0.75, commit-worthy
  harness.touch('touchmove', 280, 302)
  harness.touch('touchmove', 260, 302)
  harness.touch('touchmove', 240, 302) // reversed 60px, still above the ratio
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
