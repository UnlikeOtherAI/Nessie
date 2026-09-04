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

test('Create ends with Agent, opening the Direct messages agent tab', () => {
  const createMenu = readSource('../src/layouts/admin-shell/CreateMenuTrigger.tsx')
  const shell = readSource('../src/layouts/AdminShellLayout.tsx')
  const shellHook = readSource('../src/layouts/admin-shell/useAdminShell.ts')

  assert.match(createMenu, />Agent</)
  assert.match(createMenu, />Create a private or public agent</)
  // Agent is the last row of the menu.
  assert.ok(createMenu.indexOf('>Project<') < createMenu.indexOf('>Agent<'))
  // Desktop and the native phone sheet reach the same Direct-messages flow.
  assert.equal(shell.split('onCreateAgent={shell.navigateToNewAgent}').length - 1, 2)
  assert.match(shellHook, /'\/channels\/new\?with=agents'/)
})

test('the Direct messages composer separates people and agents and offers visibility first', () => {
  const compose = readSource('../src/pages/ChannelConversationComposePage.tsx')
  const targetTabs = readSource(
    '../src/components/features/channels/DirectMessageTargetTabs.tsx',
  )
  const creator = readSource(
    '../src/components/features/channels/DirectMessageAgentCreator.tsx',
  )
  const visibility = readSource(
    '../src/components/features/agents/AgentVisibilityPicker.tsx',
  )
  const designer = readSource('../src/pages/AgentDesignerPage.tsx')

  assert.match(compose, /<DirectMessageTargetTabs/)
  assert.match(targetTabs, /label: 'People'/)
  assert.match(targetTabs, /label: 'Agents'/)
  assert.match(compose, /<DirectMessageAgentCreator/)
  assert.match(creator, /Create a new agent/)
  assert.match(creator, /Continue to Agent Designer/)
  assert.match(visibility, /label: 'Private'/)
  assert.match(visibility, /label: 'Public'/)
  assert.match(visibility, /invite it to any channel/)
  assert.match(compose, /`\/agents\/designer\?visibility=\$\{newAgentVisibility\}`/)
  assert.match(designer, /searchParams\.get\('visibility'\) === 'private'/)
  assert.match(designer, /if \(requestedVisibility\) setVisibility\(requestedVisibility\)/)
})

test('the Create control uses the same desktop rail tooltip as Focus', () => {
  const createMenu = readSource('../src/layouts/admin-shell/CreateMenuTrigger.tsx')
  const rail = readSource('../src/layouts/admin-shell/SidebarRail.tsx')

  assert.match(createMenu, /import \{ RailTooltip \} from '\.\/RailTooltip'/)
  assert.match(createMenu, /id="create-menu-tooltip"/)
  assert.match(createMenu, /onMouseEnter=\{showTooltip\}/)
  assert.match(rail, /<RailTooltip/)
  assert.match(rail, /id="focus-mode-tooltip"/)
})

test('the whole rail keeps Focus beside creation and scrolls when space is tight', () => {
  const rail = readSource('../src/layouts/admin-shell/SidebarRail.tsx')

  assert.match(rail, /flex h-full w-\[65px\] flex-col items-center overflow-x-hidden overflow-y-auto/)
  assert.match(rail, /<nav aria-label="Main navigation" className="w-full shrink-0">/)
  assert.doesNotMatch(rail, /to="\/feedback"/)
  assert.doesNotMatch(rail, /DebugTokenButton/)
  assert.ok(rail.indexOf('>Focus</span>') < rail.indexOf('<CreateMenuTrigger'))
})

test('the Focus tooltip dismisses itself after five seconds on touch devices', () => {
  const rail = readSource('../src/layouts/admin-shell/SidebarRail.tsx')

  assert.match(rail, /const \{ capabilities \} = useViewport\(\)/)
  assert.match(rail, /capabilities\.hover/)
  assert.match(rail, /capabilities\.coarsePointer/)
  assert.match(rail, /window\.setTimeout\(dismissFocusTooltip, 5_000\)/)
})

test('the desktop Focus tooltip fades in and out quickly', () => {
  const tooltip = readSource('../src/layouts/admin-shell/RailTooltip.tsx')
  const styles = readSource('../src/styles.css')

  assert.match(tooltip, /open \? 'is-opening' : 'is-closing'/)
  assert.match(tooltip, /TOOLTIP_FADE_MS = 120/)
  assert.match(styles, /\.rail-tooltip\.is-opening\s*\{[\s\S]*?animation: rail-tooltip-enter 120ms/)
  assert.match(styles, /\.rail-tooltip\.is-closing\s*\{[\s\S]*?animation: rail-tooltip-exit 120ms/)
})
