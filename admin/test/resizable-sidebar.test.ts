import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampSidebarWidthPercent,
  minimumSidebarWidthPercent,
  parseStoredSidebarWidthPercent,
  resolveStoredSidebarWidthPercent,
  sidebarWidthCookieName,
} from '../src/layouts/admin-shell/ResizableSidebar'
import { RESIZE_HANDLE_AUTO_HIDE_MS } from '../src/hooks/useResizeHandleReveal'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

test('sidebar width is capped at 35% of the viewport', () => {
  assert.equal(clampSidebarWidthPercent(42, 1_440), 35)
})

test('sidebar width preserves a usable 200px minimum on narrower tablets', () => {
  assert.equal(minimumSidebarWidthPercent(800), 25)
  assert.equal(clampSidebarWidthPercent(18, 800), 25)
})

test('a stored viewport-relative width remains proportional when it is in bounds', () => {
  assert.equal(clampSidebarWidthPercent(28.5, 1_200), 28.5)
})

test('an absent device preference uses the current sidebar width as its baseline', () => {
  assert.equal(parseStoredSidebarWidthPercent(null), null)
  assert.equal(parseStoredSidebarWidthPercent('30'), 30)
})

// Channels, Projects, Knowledge and Admin each show a different kind of list,
// so one shared cookie meant resizing any of them resized all four.
test('each shell section persists its own sidebar width', () => {
  assert.equal(sidebarWidthCookieName('channels'), 'sidebarWidthPercent-channels')
  assert.equal(sidebarWidthCookieName('projects'), 'sidebarWidthPercent-projects')
  assert.notEqual(sidebarWidthCookieName('knowledge'), sidebarWidthCookieName('admin'))

  // getCookie compiles the name into a RegExp, so a metacharacter in it would
  // let one section read another's value.
  assert.doesNotMatch(sidebarWidthCookieName('knowledge'), /[.*+?^${}()|[\]\\]/)
})

test('a section that has never been resized falls back to the pre-section width', () => {
  assert.equal(resolveStoredSidebarWidthPercent(null, '30'), 30)
  assert.equal(resolveStoredSidebarWidthPercent('22', '30'), 22)
  assert.equal(resolveStoredSidebarWidthPercent(null, null), null)
})

test('the sidebar re-reads its width when the section changes', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/layouts/admin-shell/ResizableSidebar.tsx', import.meta.url)),
    'utf8',
  )

  // The width is state seeded at mount, so the per-section key is what stops
  // one section's width from being carried — and then persisted — into another.
  assert.match(source, /<SectionResizableSidebar[\s\S]*?key=\{section\}/)
  assert.match(source, /setCookie\(sidebarWidthCookieName\(section\)/)
  assert.doesNotMatch(source, /setCookie\(LEGACY_SIDEBAR_WIDTH_COOKIE/)
})

test('the large-phone landscape sidebar is fixed and exposes no resize control', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/layouts/admin-shell/ResizableSidebar.tsx', import.meta.url)),
    'utf8',
  )

  assert.match(source, /fixed\?: boolean/)
  assert.match(source, /fixed\s*\? `\$\{DEFAULT_SIDEBAR_WIDTH_PX\}px`/)
  assert.match(source, /\{!fixed \? \(/)
})

// The right-hand panels do not each own a divider: `SidePanelShell` is the one
// frame they share (the reply thread and the agent's screen), so the pill and
// its reveal live there once. Asserting the shell — and that every panel
// composes it — is what keeps "one divider" true, rather than checking one
// panel that could stop using the shell without failing anything.
const SIDE_PANEL_HOSTS = [
  '../src/components/features/channels/thread-panel/ThreadReplyPanel.tsx',
  '../src/components/features/browser-cloud/AgentScreenPanel.tsx',
]

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('the sidebar and reply-thread dividers use one shared resize pill', () => {
  const sidebar = readSource('../src/layouts/admin-shell/ResizableSidebar.tsx')
  const sidePanelShell = readSource(
    '../src/components/features/channels/side-panel/SidePanelShell.tsx',
  )
  const resizeHandle = readSource('../src/components/primitives/ColumnResizeHandle.tsx')

  assert.match(sidebar, /<ColumnResizeHandle \/>/)
  assert.match(sidePanelShell, /<ColumnResizeHandle \/>/)
  assert.match(sidePanelShell, /thread-panel-resize-control/)
  assert.match(resizeHandle, /className="column-resize-handle"/)

  for (const host of SIDE_PANEL_HOSTS) {
    assert.match(
      readSource(host),
      /<SidePanelShell/,
      `${host} must take its divider from the one side-panel shell`,
    )
  }
})

test('coarse-pointer resize pills automatically hide after four seconds', () => {
  const sidebar = readSource('../src/layouts/admin-shell/ResizableSidebar.tsx')
  const sidePanelShell = readSource(
    '../src/components/features/channels/side-panel/SidePanelShell.tsx',
  )
  const styles = readSource('../src/styles.css')

  assert.equal(RESIZE_HANDLE_AUTO_HIDE_MS, 4_000)
  assert.match(sidebar, /useResizeHandleReveal\(coarsePointer\)/)
  assert.match(sidebar, /scheduleHandleHide\(\)/)
  assert.match(sidePanelShell, /useResizeHandleReveal\(coarsePointer\)/)
  assert.match(sidePanelShell, /scheduleHandleHide\(\)/)
  assert.match(
    styles,
    /@media \(pointer: fine\) \{[\s\S]*?\.column-resize-control:hover \.column-resize-handle/,
  )
})
