import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  consumeDesktopPendingPath,
  desktopPlatform,
  usesCustomDesktopWindowControls,
} from '../src/lib/desktop'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

// A desktop notification clicked on a quit app fires its open event before
// the SPA subscribes; the init script retains the path and the root redirect
// replays it once (docs/navigation/overview.md §8).

test('the retained desktop path is consumed once and must be an internal path', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const fake = { __nessieDesktopPendingPath: '/channels/c1' } as Window & { __nessieDesktopPendingPath?: unknown }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fake, writable: true })
  try {
    assert.equal(consumeDesktopPendingPath(), '/channels/c1')
    assert.equal(consumeDesktopPendingPath(), null, 'consumed once')
    fake.__nessieDesktopPendingPath = '//evil.example'
    assert.equal(consumeDesktopPendingPath(), null)
    fake.__nessieDesktopPendingPath = 'https://evil.example'
    assert.equal(consumeDesktopPendingPath(), null)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else delete (globalThis as { window?: unknown }).window
  }
})

test('custom traffic lights are only exposed by Windows and Linux Tauri shells', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const fake = { __nessieDesktopPlatform: 'windows' } as Window & {
    __nessieDesktopPlatform?: unknown
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fake, writable: true })
  try {
    assert.equal(desktopPlatform(), 'windows')
    assert.equal(usesCustomDesktopWindowControls(), true)
    fake.__nessieDesktopPlatform = 'linux'
    assert.equal(usesCustomDesktopWindowControls(), true)
    fake.__nessieDesktopPlatform = 'macos'
    assert.equal(usesCustomDesktopWindowControls(), false)
    fake.__nessieDesktopPlatform = 'unknown'
    assert.equal(desktopPlatform(), null)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else delete (globalThis as { window?: unknown }).window
  }
})

test('the green traffic light owns the shared window-layout popover', () => {
  const controls = source('../src/layouts/admin-shell/DesktopWindowControls.tsx')
  const layouts = source('../src/layouts/admin-shell/WindowLayoutPopover.tsx')
  const styles = source('../src/styles.css')
  assert.match(controls, /LAYOUT_HOVER_DELAY_MS = 800/)
  assert.match(controls, /<WindowLayoutPopover/)
  assert.match(layouts, /from '..\/..\/components\/overlays\/Popover'/)
  assert.match(layouts, /className="desktop-window-layout-popover"/)
  assert.match(styles, /width: 14\.4px/)
  assert.match(styles, /height: 14\.4px/)
})

test('the embedded desktop build pins the production API before packaging', () => {
  const manifest = JSON.parse(source('../../desktop/package.json')) as { scripts: Record<string, string> }
  const embeddedBuild = source('../../desktop/scripts/build-embedded-shell.mjs')
  assert.equal(
    manifest.scripts['tauri:build:embedded'],
    'pnpm exec turbo run build --filter=@nessie/runtime && pnpm prepare:executor-runtime && node scripts/build-embedded-shell.mjs',
  )
  assert.match(embeddedBuild, /const productionApiUrl = 'https:\/\/api\.nessie\.works'/)
  assert.match(embeddedBuild, /VITE_API_BASE_URL: productionApiUrl/)
  assert.match(embeddedBuild, /adminBundle\.includes\(productionApiUrl\)/)
  assert.match(embeddedBuild, /frontendDist: '\.\.\/\.\.\/admin\/dist'/)
  assert.match(embeddedBuild, /const pnpmCliCandidates = \[/)
  assert.match(embeddedBuild, /process\.env\.APPDATA/)
  assert.match(embeddedBuild, /const runPnpm = \(arguments_, options\) => process\.platform === 'win32'/)
})

test('the init script retains the path before dispatching, and both consumers exist', () => {
  const init = source('../../desktop/src-tauri/src/desktop_notifications_init.js')
  const retain = init.indexOf('window.__nessieDesktopPendingPath = path')
  const dispatch = init.indexOf('window.dispatchEvent(new CustomEvent(OPEN_EVENT')
  assert.ok(retain !== -1 && dispatch !== -1 && retain < dispatch, 'retained before the event fires')
  assert.match(source('../src/router.tsx'), /readNativePendingPushPath\(\) \?\? consumeDesktopPendingPath\(\)/)
  assert.match(source('../src/providers/NotificationsProvider.tsx'), /consumeDesktopPendingPath\(\)/)
})
