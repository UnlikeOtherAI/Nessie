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
  // A column browser carries that precedence onto the stage it pushes.
  const viewport = readSource('../src/components/shared/column-browser/ColumnBrowserViewport.tsx')
  assert.match(viewport, /columnBackPriority\(index\)/)

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

test('app detail keeps Apps as its one visible return doorway', () => {
  // Step 9: the page's own Back moved into `ScreenHeader`'s leading lane. On
  // a phone the shared doorway resolves it; on a wide layout the header
  // renders this `onBack` because the registry says the screen has a parent.
  const page = readSource('../src/pages/AppDetailPage.tsx')
  assert.match(page, /usePhoneLayout/)
  assert.match(page, /usePhoneNavigation/)
  assert.match(page, /phoneNavigation\.performBack\(\)/)
  assert.match(page, /<ScreenHeader/)
  assert.match(page, /backLabel="Back to Apps"/)
  assert.doesNotMatch(page, /<header/, 'no second header beside the ScreenHeader')
})

// ─── Column browser doorway ──────────────────────────────────────────────────

test('a pushed column browser column owns Back through its stage, registered once', () => {
  // docs/navigation/overview.md §6: on `single` the deeper columns are nested stages,
  // so the layer's own registration is the only one — a retained column can
  // no longer compete for the doorway because it is no longer rendered.
  const viewport = readSource('../src/components/shared/column-browser/ColumnBrowserViewport.tsx')
  assert.match(viewport, /<NestedStage/)
  assert.match(viewport, /priority=\{columnBackPriority\(index\)\}/)
  assert.match(viewport, /id=\{stageId\(index\)\}/)
  assert.match(viewport, /ColumnBackProvider/)
  // Column 0 is the page, not a layer, so its Back is an ordinary owner.
  assert.match(viewport, /active: stacked && baseReport !== undefined/)
  assert.doesNotMatch(viewport, /phoneVisible/)

  const column = readSource('../src/components/shared/column-browser/ColumnBrowserColumn.tsx')
  // The column reports its Back up the one-way channel and registers nothing.
  assert.doesNotMatch(column, /useLocalBack\b/)
  assert.match(column, /reportBack\(index, \{ label: backLabel, onBack: runBack \}\)/)
  assert.match(column, /stacked\s*\? <PhoneNavigationButton/)
  // A plain track keeps the shared circular Back beside the column title.
  assert.match(column, /: <PhoneBackButton label=\{backLabel\} onBack=\{onBack\}/)

  const context = readSource('../src/layouts/admin-shell/local-back/LocalBackContext.tsx')
  assert.match(context, /reportBack: \(\(index: number, report: ColumnStageReport \| null\) => void\) \| null/)
  assert.doesNotMatch(context, /phoneVisible/)

  // The doorway no longer reads the column context at all: the stack decides
  // which layer is interactive.
  const navigation = readSource('../src/layouts/admin-shell/PhoneNavigationButton.tsx')
  assert.doesNotMatch(navigation, /useColumnBackContext/)
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
