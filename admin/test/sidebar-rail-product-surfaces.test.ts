import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('the left rail accepts only Nessie navigation items', () => {
  const rail = readSource('../src/layouts/admin-shell/SidebarRail.tsx')

  assert.match(rail, /SIDEBAR_RAIL_ITEMS\.map/)
  assert.doesNotMatch(rail, /useProductSurfaces/)
  assert.doesNotMatch(rail, /productNavPages/)
})

test('the left rail exposes the shared create actions immediately above the account control', () => {
  const rail = readSource('../src/layouts/admin-shell/SidebarRail.tsx')

  assert.match(rail, /<CreateMenuTrigger/)
  assert.match(rail, /onCreateMessage=\{onCreateMessage\}/)
  assert.ok(rail.indexOf('<CreateMenuTrigger') < rail.indexOf('<UserMenuTrigger'))
})

test('the whole rail keeps Feedback beside Focus and scrolls when space is tight', () => {
  const rail = readSource('../src/layouts/admin-shell/SidebarRail.tsx')

  assert.match(rail, /flex h-full w-\[65px\] flex-col items-center overflow-x-hidden overflow-y-auto/)
  assert.match(rail, /<nav aria-label="Main navigation" className="w-full shrink-0">/)
  assert.ok(rail.indexOf('>Feedback</span>') < rail.indexOf('>Focus</span>'))
})

test('the Focus tooltip dismisses itself after five seconds on touch devices', () => {
  const rail = readSource('../src/layouts/admin-shell/SidebarRail.tsx')

  assert.match(rail, /const \{ capabilities \} = useViewport\(\)/)
  assert.match(rail, /capabilities\.hover/)
  assert.match(rail, /capabilities\.coarsePointer/)
  assert.match(rail, /window\.setTimeout\(dismissFocusTooltip, 5_000\)/)
})

test('the desktop Focus tooltip fades in and out quickly', () => {
  const rail = readSource('../src/layouts/admin-shell/SidebarRail.tsx')
  const styles = readSource('../src/styles.css')

  assert.match(rail, /focusTooltipMounted && typeof document !== 'undefined'/)
  assert.match(rail, /focusTooltipOpen \? 'is-opening' : 'is-closing'/)
  assert.match(rail, /TOOLTIP_FADE_MS = 120/)
  assert.match(styles, /\.focus-mode-tooltip\.is-opening\s*\{[\s\S]*?animation: focus-tooltip-enter 120ms/)
  assert.match(styles, /\.focus-mode-tooltip\.is-closing\s*\{[\s\S]*?animation: focus-tooltip-exit 120ms/)
})
