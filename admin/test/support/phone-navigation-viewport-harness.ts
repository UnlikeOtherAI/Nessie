import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import type { ReactNode } from 'react'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/channels',
  pretendToBeVisual: true,
})

let nextFrameHandle = 1
let frameClock = 0
const pendingFrames = new Map<number, FrameRequestCallback>()

const domGlobals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Touch: dom.window.Touch,
  TouchEvent: dom.window.TouchEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (callback: FrameRequestCallback) => {
    const handle = nextFrameHandle
    nextFrameHandle += 1
    pendingFrames.set(handle, callback)
    return handle
  },
  cancelAnimationFrame: (handle: number) => pendingFrames.delete(handle),
  IS_REACT_ACT_ENVIRONMENT: true,
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

for (const [name, value] of Object.entries({
  sm: '40rem',
  md: '48rem',
  lg: '64rem',
  xl: '80rem',
  '2xl': '96rem',
})) {
  dom.window.document.documentElement.style.setProperty(`--breakpoint-${name}`, value)
}

Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get: () => 390,
})

// jsdom has no Web Animations API. Navigation motion runs entirely on
// element.animate() (admin/src/navigation/motion.ts), so the harness supplies
// a timeline that finishes after the requested duration on real timers — the
// same clock the tests' flush() waits on — and can be cancelled or finished
// early. Tests drive transitions to completion through it, not through the
// viewport's fallback timer.
type FakeAnimation = {
  currentTime: number
  effect: { getTiming: () => { duration: number } }
  playState: 'running' | 'finished' | 'idle'
  onfinish: (() => void) | null
  oncancel: (() => void) | null
  finish: () => void
  cancel: () => void
}
const fakeAnimations = new Set<FakeAnimation>()
Object.defineProperty(dom.window.Element.prototype, 'animate', {
  configurable: true,
  writable: true,
  value: function animate(
    this: Element,
    _keyframes: unknown,
    options?: number | { duration?: number | string },
  ): FakeAnimation {
    const duration = typeof options === 'number'
      ? options
      : Number(options?.duration ?? 0)
    let timer: ReturnType<typeof setTimeout> | null = null
    const animation: FakeAnimation = {
      currentTime: 0,
      effect: { getTiming: () => ({ duration }) },
      playState: 'running',
      onfinish: null,
      oncancel: null,
      finish: () => {
        if (animation.playState !== 'running') return
        if (timer) clearTimeout(timer)
        animation.playState = 'finished'
        animation.currentTime = duration
        fakeAnimations.delete(animation)
        animation.onfinish?.()
      },
      cancel: () => {
        if (animation.playState === 'idle') return
        if (timer) clearTimeout(timer)
        animation.playState = 'idle'
        fakeAnimations.delete(animation)
        animation.oncancel?.()
      },
    }
    fakeAnimations.add(animation)
    timer = setTimeout(() => animation.finish(), duration)
    return animation
  },
})

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { MemoryRouter, useLocation, useNavigate } = await import('react-router-dom')
const { PhoneNavigationViewport } = await import(
  '../../src/layouts/admin-shell/PhoneNavigationViewport'
)
const { NestedStage } = await import('../../src/navigation/NestedStage')
const { PhoneNavigationProvider } = await import(
  '../../src/layouts/admin-shell/PhoneNavigationProvider'
)
const { LocalBackProvider, useLocalBackSnapshot } = await import(
  '../../src/layouts/admin-shell/local-back/LocalBackContext'
)
type BackOwner = { id: string; label: string; onBack: () => void } | null

export type PhoneNavigationViewportHarness = {
  // The registry's current Back owner — the deepest registered stage or
  // overlay — or null when the route's own parent owns the doorway.
  backOwner: () => BackOwner
  container: HTMLElement
  // Opens or closes the detail screen's nested stage (a state-driven screen
  // the page pushes over itself), the way a page toggles its own state.
  setStage: (active: boolean) => Promise<void>
  currentPathname: () => HTMLElement | null
  flush: (ms?: number) => Promise<void>
  goTo: (pathname: string, paint?: boolean) => Promise<void>
  historyBack: () => Promise<void>
  layer: (name: string) => HTMLElement | null
  locationLabel: () => string
  mounts: () => Record<string, number>
  paintFrame: () => Promise<void>
  // Runs `mutate` inside act(), for a test driving the page's own state.
  render: (mutate: () => void) => Promise<void>
  scrollTops: () => Record<string, number>
  touch: (
    type: string,
    x: number,
    y: number,
    target?: Element | null,
    dt?: number,
  ) => void
  unmount: () => Promise<void>
}

export type PhoneNavigationViewportOptions = {
  // Replaces the detail route's default nested-stage fixture. An adopter that
  // mounts its own stages (the column browser) renders itself here and drives
  // them with `render`, while `setStage` keeps serving the default fixture.
  renderDetail?: () => ReactNode
  // Seeds the registry's parent chain beneath a cold start's landing route
  // with a labelled placeholder per seeded pathname (docs/navigation.md §8).
  seed?: boolean
}

// One component type renders every route, so mount counts prove which exact
// instances survive navigation. The controlled frame queue makes the forward
// screen's prepare/paint/run lifecycle deterministic without a paint engine.
export const mountPhoneNavigationViewport = async (
  initialPathname: string,
  options: PhoneNavigationViewportOptions = {},
): Promise<PhoneNavigationViewportHarness> => {
  pendingFrames.clear()
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  let pathname = initialPathname
  let navigateTo: ((to: string | number) => void) | null = null
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
  // The detail's nested stage is toggled from outside React through a tiny
  // store, so a test can open and close it like the page's own state.
  const stageListeners = new Set<() => void>()
  let stageActive = false
  const stageStore = {
    subscribe: (listener: () => void) => {
      stageListeners.add(listener)
      return () => stageListeners.delete(listener)
    },
    getSnapshot: () => stageActive,
  }
  const ChannelsDetail = () => {
    React.useEffect(() => {
      mounts['channels-detail'] = (mounts['channels-detail'] ?? 0) + 1
      return () => {
        mounts['channels-detail'] = (mounts['channels-detail'] ?? 1) - 1
      }
    }, [])
    const active = React.useSyncExternalStore(stageStore.subscribe, stageStore.getSnapshot)
    if (options.renderDetail) return options.renderDetail()
    return h(
      React.Fragment,
      null,
      h(Screen, { label: '/channels/channel_a' }),
      h(
        NestedStage,
        {
          active,
          id: 'inspector',
          label: 'Back from inspector',
          onBack: () => {
            stageActive = false
            for (const listener of stageListeners) listener()
          },
          priority: 30,
        },
        h('div', { 'data-stage': 'inspector' }, 'stage:inspector'),
      ),
    )
  }

  // Reads the one Back registry the shell doorway reads, so a test can assert
  // which owner holds Back and invoke exactly the action a tap would.
  let backOwner: BackOwner = null
  const BackProbe = () => {
    backOwner = useLocalBackSnapshot()?.active ?? null
    return null
  }

  const Host = () => {
    const location = useLocation()
    const navigate = useNavigate()
    pathname = location.pathname
    navigateTo = (next: string | number) => {
      if (typeof next === 'number') navigate(next)
      else navigate(next)
    }
    if (!location.pathname.startsWith('/channels')) {
      return h('div', { 'data-outside-route': location.pathname })
    }
    return h(
      PhoneNavigationViewport,
      {
        pathname: location.pathname,
        ...(options.seed
          ? { seed: (seeded: string) => h('div', { 'data-seeded': seeded }, `seeded:${seeded}`) }
          : {}),
      },
      h(ScreenForPath, { path: location.pathname }),
    )
  }

  const root = createRoot(container)
  const flush = async (ms = 0) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms))
    })
  }
  const paintFrame = async () => {
    const callbacks = [...pendingFrames.values()]
    pendingFrames.clear()
    frameClock += 16.67
    await act(async () => {
      for (const callback of callbacks) callback(frameClock)
    })
  }

  await act(async () => {
    root.render(
      h(
        MemoryRouter,
        { initialEntries: ['/outside', initialPathname], initialIndex: 1 },
        h(
          LocalBackProvider,
          null,
          h(PhoneNavigationProvider, null, h(BackProbe), h(Host)),
        ),
      ),
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
    backOwner: () => backOwner,
    container,
    render: async (mutate: () => void) => {
      await act(async () => mutate())
      await flush()
    },
    setStage: async (active: boolean) => {
      stageActive = active
      await act(async () => {
        for (const listener of stageListeners) listener()
      })
      await flush()
    },
    currentPathname: () =>
      container.querySelector(
        '[data-phone-navigation-layer="current"] [data-screen-label]',
      ),
    flush,
    goTo: async (next: string, paint = true) => {
      assert.ok(navigateTo, 'router ready')
      await act(async () => navigateTo(next))
      await flush()
      if (paint) {
        await paintFrame()
        await paintFrame()
      }
    },
    historyBack: async () => {
      assert.ok(navigateTo, 'router ready')
      await act(async () => navigateTo(-1))
      await flush()
    },
    layer: (name) => container.querySelector(`[data-phone-navigation-layer="${name}"]`),
    locationLabel: () => pathname,
    mounts: () => ({ ...mounts }),
    paintFrame,
    scrollTops: () => ({ ...scrollTops }),
    touch,
    unmount: async () => {
      await act(async () => root.unmount())
      pendingFrames.clear()
      container.remove()
      for (const key of Object.keys(domGlobals)) {
        const descriptor = previousGlobals.get(key)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}
