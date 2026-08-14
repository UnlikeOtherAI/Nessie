import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

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

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { MemoryRouter, useLocation, useNavigate } = await import('react-router-dom')
const { PhoneNavigationViewport } = await import(
  '../../src/layouts/admin-shell/PhoneNavigationViewport'
)
const { PhoneNavigationProvider } = await import(
  '../../src/layouts/admin-shell/PhoneNavigationProvider'
)

export type PhoneNavigationViewportHarness = {
  container: HTMLElement
  currentPathname: () => HTMLElement | null
  flush: (ms?: number) => Promise<void>
  goTo: (pathname: string, paint?: boolean) => Promise<void>
  historyBack: () => Promise<void>
  layer: (name: string) => HTMLElement | null
  locationLabel: () => string
  mounts: () => Record<string, number>
  paintFrame: () => Promise<void>
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

// One component type renders every route, so mount counts prove which exact
// instances survive navigation. The controlled frame queue makes the forward
// screen's prepare/paint/run lifecycle deterministic without a paint engine.
export const mountPhoneNavigationViewport = async (
  initialPathname: string,
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
    navigateTo = (next: string | number) => {
      if (typeof next === 'number') navigate(next)
      else navigate(next)
    }
    if (!location.pathname.startsWith('/channels')) {
      return h('div', { 'data-outside-route': location.pathname })
    }
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
        h(PhoneNavigationProvider, null, h(Host)),
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
    container,
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
