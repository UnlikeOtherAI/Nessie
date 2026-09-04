import assert from 'node:assert/strict'
import test from 'node:test'

import * as ReactNamespace from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { DesktopWindowFrame } from '../src/components/desktop/DesktopWindowFrame.js'
import type { DesktopWindowFrameAdapter } from '../src/components/desktop/desktop-window-adapter.js'

;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const adapter: DesktopWindowFrameAdapter = {
  isFullscreen: async () => false,
  isMaximized: async () => false,
  onResized: async () => () => undefined,
  startResizeDragging: async () => undefined,
  toggleMaximize: async () => undefined,
}

const renderFrame = (platform: 'linux' | 'macos' | 'windows' | null): string =>
  renderToStaticMarkup(
    createElement(
      DesktopWindowFrame,
      { adapter, platform },
      createElement('main', { id: 'workspace' }, 'Nessie'),
    ),
  )

test('Linux and Windows render the same shared controls with platform-owned silhouettes', () => {
  const windows = renderFrame('windows')
  const linux = renderFrame('linux')
  assert.match(windows, /data-platform="windows"/)
  assert.match(linux, /data-platform="linux"/)
  assert.match(windows, /aria-label="Window controls"/)
  assert.match(linux, /aria-label="Window controls"/)
  assert.match(windows, /data-tauri-drag-region/)
  assert.match(linux, /data-tauri-drag-region/)
  assert.equal((windows.match(/class="desktop-window-frame-resize /g) ?? []).length, 8)
  assert.equal((linux.match(/class="desktop-window-frame-resize /g) ?? []).length, 8)
})

test('the web and macOS keep their existing native frame', () => {
  const content = '<main id="workspace">Nessie</main>'
  assert.equal(renderFrame(null), content)
  assert.equal(renderFrame('macos'), content)
})
