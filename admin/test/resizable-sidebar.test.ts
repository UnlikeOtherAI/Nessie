import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampSidebarWidthPercent,
  minimumSidebarWidthPercent,
  parseStoredSidebarWidthPercent,
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

test('the large-phone landscape sidebar is fixed and exposes no resize control', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/layouts/admin-shell/ResizableSidebar.tsx', import.meta.url)),
    'utf8',
  )

  assert.match(source, /fixed\?: boolean/)
  assert.match(source, /fixed\s*\? `\$\{DEFAULT_SIDEBAR_WIDTH_PX\}px`/)
  assert.match(source, /\{!fixed \? \(/)
})

test('the sidebar and reply-thread dividers use one shared resize pill', () => {
  const sidebar = readFileSync(
    fileURLToPath(new URL('../src/layouts/admin-shell/ResizableSidebar.tsx', import.meta.url)),
    'utf8',
  )
  const threadPanel = readFileSync(
    fileURLToPath(new URL('../src/components/features/channels/thread-panel/ThreadReplyPanel.tsx', import.meta.url)),
    'utf8',
  )
  const resizeHandle = readFileSync(
    fileURLToPath(new URL('../src/components/primitives/ColumnResizeHandle.tsx', import.meta.url)),
    'utf8',
  )

  assert.match(sidebar, /<ColumnResizeHandle \/>/)
  assert.match(threadPanel, /<ColumnResizeHandle \/>/)
  assert.match(threadPanel, /thread-panel-resize-control/)
  assert.match(resizeHandle, /className="column-resize-handle"/)
})

test('coarse-pointer resize pills automatically hide after four seconds', () => {
  const sidebar = readFileSync(
    fileURLToPath(new URL('../src/layouts/admin-shell/ResizableSidebar.tsx', import.meta.url)),
    'utf8',
  )
  const threadPanel = readFileSync(
    fileURLToPath(new URL('../src/components/features/channels/thread-panel/ThreadReplyPanel.tsx', import.meta.url)),
    'utf8',
  )
  const styles = readFileSync(
    fileURLToPath(new URL('../src/styles.css', import.meta.url)),
    'utf8',
  )

  assert.equal(RESIZE_HANDLE_AUTO_HIDE_MS, 4_000)
  assert.match(sidebar, /useResizeHandleReveal\(coarsePointer\)/)
  assert.match(sidebar, /scheduleHandleHide\(\)/)
  assert.match(threadPanel, /useResizeHandleReveal\(coarsePointer\)/)
  assert.match(threadPanel, /scheduleHandleHide\(\)/)
  assert.match(
    styles,
    /@media \(pointer: fine\) \{[\s\S]*?\.column-resize-control:hover \.column-resize-handle/,
  )
})
