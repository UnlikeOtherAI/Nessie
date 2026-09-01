import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

// ─── One reusable control ────────────────────────────────────────────────────

test('every phone Back doorway renders through the one shared PhoneBackButton', () => {
  const navigation = readSource('../src/layouts/admin-shell/PhoneNavigationButton.tsx')
  // The doorway renders the one resolver's decision and never re-derives it.
  assert.match(navigation, /resolveBackAction\(location\.pathname\)/)
  assert.doesNotMatch(navigation, /getPhoneNavigationBackTarget/)
  // Ownership order lives in the resolver: a registered owner first, the
  // route's deterministic Back second, nothing at a root.
  const resolver = readSource('../src/navigation/back.ts')
  assert.ok(
    resolver.indexOf('const owner = owners?.active')
      < resolver.indexOf('const target = getPhoneNavigationBackTarget('),
    'an owner must resolve before the route parent',
  )

  const column = readSource('../src/components/shared/column-browser/ColumnBrowserColumn.tsx')
  assert.match(column, /PhoneBackButton/)
  assert.doesNotMatch(column, /<svg/, 'no second hand-drawn Back icon')
})

test('registrations use explicit numeric priority, never mount order', () => {
  const context = readSource('../src/layouts/admin-shell/local-back/LocalBackContext.tsx')
  assert.match(context, /LOCAL_BACK_PRIORITY/)
  assert.match(context, /columnBackPriority/)
  assert.match(context, /useLayoutEffect/)

  const hook = readSource('../src/layouts/admin-shell/local-back/local-back-registry.ts')
  assert.match(hook, /byPriority\(right\) - byPriority\(left\)/)
})

test('admin column-browser pages delegate Back to the shared column, with no ad-hoc phone Back buttons', () => {
  for (const page of [
    '../src/pages/IntegrationsPage.tsx',
    '../src/pages/ToolsPage.tsx',
    '../src/pages/TriggersPage.tsx',
    '../src/pages/WorkflowsPage.tsx',
  ]) {
    const source = readSource(page)
    assert.doesNotMatch(source, /aria-label="Back/, `${page} must not render its own Back button`)
    assert.doesNotMatch(source, />Back</, `${page} must not render an ad-hoc Back label`)
  }
})

test('app detail keeps Apps as its one visible phone return doorway', () => {
  const page = readSource('../src/pages/AppDetailPage.tsx')
  assert.match(page, /usePhoneLayout/)
  assert.match(page, /usePhoneNavigation/)
  assert.match(page, /phoneNavigation\.performBack\(\)/)
  assert.match(page, /!phoneLayout \? <PhoneNavigationButton \/> : null/)
  assert.match(page, /data-testid="app-detail-back"/)
})

// ─── Column browser doorway ──────────────────────────────────────────────────

test('only the phone-visible column browser column holds the Back doorway', () => {
  const viewport = readSource('../src/components/shared/column-browser/ColumnBrowserViewport.tsx')
  assert.match(viewport, /phoneVisibleIndex/)
  assert.match(viewport, /ColumnBackProvider/)
  assert.match(viewport, /const phoneHidden = isMobile && index !== phoneVisibleIndex/)
  assert.match(viewport, /aria-hidden=\{phoneHidden \|\| undefined\}/)
  assert.match(viewport, /inert=\{phoneHidden \|\| undefined\}/)

  const column = readSource('../src/components/shared/column-browser/ColumnBrowserColumn.tsx')
  assert.match(column, /active: phoneLayout && phoneVisible && Boolean\(showBack && onBack\)/)
  assert.match(column, /priority: columnBackPriority\(index \?\? 0\)/)
  assert.match(column, /phoneLayout\s*\? phoneVisible\s*\? <PhoneNavigationButton/)
  // Wider layouts keep the shared circular Back beside the column title.
  assert.match(column, /: <PhoneBackButton label=\{backLabel\} onBack=\{onBack\}/)

  const navigation = readSource('../src/layouts/admin-shell/PhoneNavigationButton.tsx')
  assert.match(navigation, /useColumnBackContext/)
  assert.match(navigation, /column\.index !== null && !column\.phoneVisible/)
})

test('every stateful column-browser detail column owns exactly one Back action', () => {
  const expectations: Array<[string, RegExp]> = [
    ['../src/pages/ToolsPage.tsx', /onBack=\{\(\) => setSelectedToolId\(undefined\)\}[\s\S]*?showBack/],
    ['../src/pages/TriggersPage.tsx', /onBack=\{\(\) => state\.setSelectedTriggerId\(undefined\)\}[\s\S]*?showBack/],
  ]
  for (const [path, pattern] of expectations) {
    assert.match(readSource(path), pattern, path)
  }

  const workflows = readSource('../src/pages/WorkflowsPage.tsx')
  // Failed runs, template, installation, and run columns each own one Back.
  assert.equal((workflows.match(/^        showBack$/gm) ?? []).length, 4, workflows)
})
