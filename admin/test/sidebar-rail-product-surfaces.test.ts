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
  assert.match(rail, /window\.setTimeout\(\(\) => setFocusTooltipOpen\(false\), 5_000\)/)
})
