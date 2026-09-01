import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'
import * as ReactNamespace from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { DesktopWindowFrame } from '../src/components/desktop/DesktopWindowFrame.js'
import type {
  DesktopResizeDirection,
  DesktopWindowAdapter,
} from '../src/components/desktop/desktop-window-adapter.js'

/**
 * The one frame for the two frameless desktop shells (design:
 * docs/plans/2026-09-01-linux-desktop-delivery.md → "Shared shell contract").
 *
 * Two properties are worth pinning. First, it is a no-op everywhere else: the
 * web build and the macOS build must stay byte-identical, because macOS draws
 * its own traffic lights and a browser has a browser. Second, the window state
 * comes from the OS, never from what the frame believes it just did — a snap
 * gesture, Win+Arrow and a tiling window manager all change it without asking.
 */

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

type Recorder = {
  adapter: DesktopWindowAdapter
  calls: string[]
  resizes: DesktopResizeDirection[]
  setMaximized: (value: boolean) => void
}

const recorder = (initial: { fullscreen?: boolean; maximized?: boolean } = {}): Recorder => {
  const calls: string[] = []
  const resizes: DesktopResizeDirection[] = []
  let fullscreen = initial.fullscreen ?? false
  let maximized = initial.maximized ?? false
  return {
    calls,
    resizes,
    setMaximized: (value) => {
      maximized = value
    },
    adapter: {
      close: async () => {
        calls.push('close')
      },
      isFullscreen: async () => fullscreen,
      isMaximized: async () => maximized,
      minimize: async () => {
        calls.push('minimize')
      },
      onResized: async () => () => calls.push('unlisten'),
      setFullscreen: async (next) => {
        fullscreen = next
        calls.push(`setFullscreen:${next}`)
      },
      startResizeDragging: async (direction) => {
        resizes.push(direction)
      },
      toggleMaximize: async () => {
        maximized = !maximized
        calls.push('toggleMaximize')
      },
    },
  }
}

const staticRender = (platform: 'linux' | 'macos' | 'windows' | null): string =>
  renderToStaticMarkup(
    createElement(DesktopWindowFrame, {
      adapter: recorder().adapter,
      children: createElement('main', { id: 'app' }, 'workspace'),
      platform,
    }),
  )

test('the web and macOS builds get the children and nothing else', () => {
  for (const platform of [null, 'macos'] as const) {
    const html = staticRender(platform)
    assert.equal(html, '<main id="app">workspace</main>')
  }
})

test('the frameless shells get a drag strip, three controls and eight grips', () => {
  for (const platform of ['linux', 'windows'] as const) {
    const html = staticRender(platform)
    assert.match(html, new RegExp(`class="desktop-frame"[^>]*data-platform="${platform}"`))
    assert.match(html, /data-tauri-drag-region/)
    assert.match(html, /aria-label="Minimize window"/)
    assert.match(html, /aria-label="Maximize window"/)
    assert.match(html, /aria-label="Close window"/)
    assert.equal((html.match(/class="desktop-frame-resize/g) ?? []).length, 8)
    assert.match(html, /<main id="app">workspace<\/main>/)
  }
})

// ---------------------------------------------------------------------------
// The live window state. These need effects, so they mount into jsdom the way
// the confirm-dialog suite does.
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/login',
})

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')

const domGlobals = {
  document: dom.window.document,
  Element: dom.window.Element,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  navigator: dom.window.navigator,
  window: dom.window,
}

type Mounted = {
  container: HTMLElement
  frame: HTMLElement
  unmount: () => Promise<void>
}

const mount = async (
  platform: 'linux' | 'windows',
  state: Recorder,
): Promise<Mounted> => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(h(DesktopWindowFrame, { adapter: state.adapter, platform }, h('main', null, 'app')))
  })
  return {
    container: container as unknown as HTMLElement,
    frame: container.firstElementChild as unknown as HTMLElement,
    unmount: async () => {
      await act(async () => root.unmount())
      container.remove()
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete (globalThis as Record<string, unknown>)[key]
      }
    },
  }
}

test('a maximized window shows Restore, drops the grips, and goes flush', async () => {
  const state = recorder({ maximized: true })
  const mounted = await mount('windows', state)
  try {
    assert.equal(mounted.frame.dataset.flush, 'true')
    assert.ok(mounted.container.querySelector('[aria-label="Restore window"]'))
    assert.equal(mounted.container.querySelectorAll('.desktop-frame-resize').length, 0)
    // The gutter and the radius belong to a floating window only, so the app's
    // live area goes back to the full viewport.
    assert.equal(dom.window.document.documentElement.dataset.desktopFrameFlush, 'true')
  } finally {
    await mounted.unmount()
  }
})

test('a restored window shows Maximize and all eight grips', async () => {
  const state = recorder()
  const mounted = await mount('linux', state)
  try {
    assert.equal(mounted.frame.dataset.flush, 'false')
    assert.ok(mounted.container.querySelector('[aria-label="Maximize window"]'))
    assert.equal(mounted.container.querySelectorAll('.desktop-frame-resize').length, 8)
    assert.equal(dom.window.document.documentElement.dataset.desktopFrame, 'linux')
    assert.equal(dom.window.document.documentElement.dataset.desktopFrameFlush, 'false')
  } finally {
    await mounted.unmount()
  }
  // The geometry hints are the frame's own; unmounting must return `html` to a
  // plain web document.
  assert.equal(dom.window.document.documentElement.dataset.desktopFrame, undefined)
})

test('the controls reach the window and the corner grip names its direction', async () => {
  const state = recorder()
  const mounted = await mount('windows', state)
  try {
    const click = (selector: string) => {
      const node = mounted.container.querySelector(selector) as HTMLElement
      assert.ok(node, `${selector} exists`)
      node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    }
    const grip = mounted.container.querySelector('.desktop-frame-resize--se') as HTMLElement
    await act(async () => {
      grip.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })
    assert.deepEqual(state.resizes, ['SouthEast'])

    await act(async () => click('[aria-label="Minimize window"]'))
    // Maximizing removes the grips, so it comes after the grip assertion.
    await act(async () => click('[aria-label="Maximize window"]'))
    await act(async () => click('[aria-label="Close window"]'))
    assert.deepEqual(
      state.calls.filter((entry) => entry !== 'unlisten'),
      ['minimize', 'toggleMaximize', 'close'],
    )
    assert.equal(mounted.frame.dataset.flush, 'true')
  } finally {
    await mounted.unmount()
  }
})

// Windows' OS drag loop maximizes on a double-click by itself; adding a second
// toggle there would put the window straight back where it started.
test('double-clicking the drag strip toggles maximize on Linux only', async () => {
  for (const platform of ['linux', 'windows'] as const) {
    const state = recorder()
    const mounted = await mount(platform, state)
    try {
      const strip = mounted.container.querySelector('.desktop-frame-drag') as HTMLElement
      await act(async () => {
        strip.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }))
      })
      assert.deepEqual(
        state.calls.filter((entry) => entry === 'toggleMaximize'),
        platform === 'linux' ? ['toggleMaximize'] : [],
      )
    } finally {
      await mounted.unmount()
    }
  }
})

// There is no menu bar on either shell, so these two keys are the whole
// window-level keyboard. Alt+F4 stays the OS's on Windows.
test('F11 toggles fullscreen everywhere and Ctrl+Q closes on Linux only', async () => {
  for (const platform of ['linux', 'windows'] as const) {
    const state = recorder()
    const mounted = await mount(platform, state)
    try {
      await act(async () => {
        dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'F11' }))
      })
      await act(async () => {
        dom.window.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'q' }),
        )
      })
      assert.ok(state.calls.includes('setFullscreen:true'), `${platform} toggles fullscreen`)
      assert.equal(state.calls.includes('close'), platform === 'linux')
    } finally {
      await mounted.unmount()
    }
  }
})
