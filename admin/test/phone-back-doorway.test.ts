import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

// ─── One reusable control ────────────────────────────────────────────────────

test('every phone Back doorway renders through the one shared PhoneBackButton', () => {
  const navigation = readSource('../src/layouts/admin-shell/PhoneNavigationButton.tsx')
  assert.match(navigation, /useLocalBackSnapshot/)
  // Ownership order: local registry first, the route's deterministic Back
  // second, the section menu at tab roots.
  assert.ok(
    navigation.indexOf('if (localBack)') < navigation.indexOf('if (backTarget)'),
    'local Back must resolve before the route provider',
  )

  const column = readSource('../src/components/shared/column-browser/ColumnBrowserColumn.tsx')
  const detail = readSource('../src/components/features/agents/AgentDetailColumn.tsx')
  for (const source of [column, detail]) {
    assert.match(source, /PhoneBackButton/)
    assert.doesNotMatch(source, /<svg/, 'no second hand-drawn Back icon')
  }
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
    '../src/pages/McpAppStorePage.tsx',
  ]) {
    const source = readSource(page)
    assert.doesNotMatch(source, /aria-label="Back/, `${page} must not render its own Back button`)
    assert.doesNotMatch(source, />Back</, `${page} must not render an ad-hoc Back label`)
  }
})

// ─── Column browser doorway ──────────────────────────────────────────────────

test('only the phone-visible column browser column holds the Back doorway', () => {
  const viewport = readSource('../src/components/shared/column-browser/ColumnBrowserViewport.tsx')
  assert.match(viewport, /phoneVisibleIndex/)
  assert.match(viewport, /ColumnBackProvider/)

  const column = readSource('../src/components/shared/column-browser/ColumnBrowserColumn.tsx')
  assert.match(column, /active: phoneLayout && phoneVisible && Boolean\(showBack && onBack\)/)
  assert.match(column, /priority: columnBackPriority\(index \?\? 0\)/)
  // Wider layouts keep the column's own Back control beside its title.
  assert.match(column, /!phoneLayout && showBack && onBack \? \(/)
})

test('every stateful column-browser detail column owns exactly one Back action', () => {
  const expectations: Array<[string, RegExp]> = [
    ['../src/pages/ToolsPage.tsx', /onBack=\{\(\) => setSelectedToolId\(undefined\)\}[\s\S]*?showBack/],
    ['../src/pages/TriggersPage.tsx', /onBack=\{\(\) => state\.setSelectedTriggerId\(undefined\)\}[\s\S]*?showBack/],
    ['../src/pages/McpAppStorePage.tsx', /onBack=\{\(\) => setSelectedCatalogId\(undefined\)\}[\s\S]*?showBack/],
    ['../src/pages/McpAppStorePage.tsx', /onBack=\{\(\) => setSelectedLibraryEntry\(null\)\}[\s\S]*?showBack/],
    ['../src/components/features/agents/AgentDetailColumn.tsx', /useLocalBack\(\{[\s\S]*?phoneVisible/],
  ]
  for (const [path, pattern] of expectations) {
    assert.match(readSource(path), pattern, path)
  }

  const workflows = readSource('../src/pages/WorkflowsPage.tsx')
  // Failed runs, template, installation, and run columns each own one Back.
  assert.equal((workflows.match(/^        showBack$/gm) ?? []).length, 4, workflows)
})
