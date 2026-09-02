import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Step 6 adopter (docs/navigation/overview.md §6): the dashboard side panels and the
// executor pairing panel join the navigation stack as nested stages. Both
// pages are verified by source pins — the exact ids, priorities, labels and
// close paths a component-level render cannot see any more cheaply than
// reading the file.
//
// An interactive jsdom render of either page (following the pattern in
// e.g. admin/test/apps-connect-scope.test.ts and
// admin/test/knowledge-displayed-space.test.ts, to prove a stage renders
// inline where no NestedStageHostContext is present — the split-layout /
// no-stack-host case NestedStage itself branches on) was attempted and
// dropped for both:
// - DashboardDetailPage transitively imports DashboardGrid, which imports
//   'react-grid-layout/css/styles.css' at module scope. Vite's dev/build
//   pipeline handles that; the plain `node --test --import tsx` loader this
//   suite runs under has no CSS loader, so importing the page crashes with
//   `Unknown file extension ".css"` before any component renders. Stubbing
//   that would mean adding a custom ESM loader hook to the test run — new
//   test infrastructure, not exercising this adoption.
// - ExecutorsPage renders behind `useAuthSession()` (AuthSessionProvider,
//   which self-fetches session state) plus a dozen executor/agent/project/
//   user queries, so a real interactive mount would mean reconstructing that
//   whole provider rather than exercising the adoption itself.

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('DashboardDetailPage wraps its side panels in NestedStage with the shared ids and priorities', () => {
  const source = readSource('../src/pages/DashboardDetailPage.tsx')

  assert.match(source, /^import \{ NestedStage \} from '\.\.\/navigation\/NestedStage'$/m)
  assert.match(
    source,
    /^import \{ LOCAL_BACK_PRIORITY \} from '\.\.\/layouts\/admin-shell\/local-back\/LocalBackContext'$/m,
  )

  assert.match(source, /<NestedStage[\s\S]{0,200}id="dashboard:add-widget"/)
  assert.match(source, /<NestedStage[\s\S]{0,200}id="dashboard:versions"/)
  assert.match(
    source,
    /id="dashboard:add-widget"[\s\S]{0,200}priority=\{LOCAL_BACK_PRIORITY\.dashboardPanel\}/,
  )
  assert.match(
    source,
    /id="dashboard:versions"[\s\S]{0,200}priority=\{LOCAL_BACK_PRIORITY\.dashboardVersions\}/,
  )
  assert.match(
    source,
    /id="dashboard:add-widget"[\s\S]{0,200}label="Back to dashboard"/,
  )
  assert.match(
    source,
    /id="dashboard:versions"[\s\S]{0,200}label="Back to dashboard"/,
  )
  // Both stages close through the same handler the panel's own ✕ uses —
  // `onBack` is the panel's close, not a second dismissal path.
  assert.match(source, /onBack=\{\(\) => setShowAddWidget\(false\)\}/)
  assert.match(source, /onBack=\{\(\) => setShowVersions\(false\)\}/)
  // Kept mounted: neither stage is gated by a `showX ? <NestedStage>… : null`
  // at the call site — only `active` toggles.
  assert.doesNotMatch(source, /showAddWidget \? [\s\S]{0,40}<NestedStage/)
  assert.doesNotMatch(source, /showVersions \? [\s\S]{0,40}<NestedStage/)

  assert.doesNotMatch(source, /\buseLocalBack\(/)
  assert.doesNotMatch(source, /\busePhoneLayout\(/)
})

test('ExecutorsPage wraps ExecutorCreatePanel in NestedStage with the shared id and priority', () => {
  const source = readSource('../src/pages/ExecutorsPage.tsx')

  assert.match(source, /^import \{ NestedStage \} from '\.\.\/navigation\/NestedStage'$/m)
  assert.match(
    source,
    /^import \{ LOCAL_BACK_PRIORITY \} from '\.\.\/layouts\/admin-shell\/local-back\/LocalBackContext'$/m,
  )

  assert.match(source, /<NestedStage[\s\S]{0,200}id="executors:create"/)
  assert.match(
    source,
    /id="executors:create"[\s\S]{0,200}priority=\{LOCAL_BACK_PRIORITY\.executorsCreate\}/,
  )
  assert.match(source, /id="executors:create"[\s\S]{0,200}label="Back to executors"/)
  assert.match(source, /active=\{showCreate && Boolean\(me\)\}/)
  assert.match(source, /onBack=\{\(\) => setShowCreate\(false\)\}/)
  assert.doesNotMatch(source, /showCreate && me \? [\s\S]{0,40}<NestedStage/)

  // The "Pair executor / Close pairing" header toggle is untouched by the
  // adoption — it still flips the same boolean the stage's `active` reads.
  // Step 9 moved it into `ScreenHeader`'s measured actions lane, so it is a
  // PageHeaderAction's `onSelect` rather than a raw button's `onClick`.
  assert.match(source, /onSelect: \(\) => setShowCreate\(\(open\) => !open\)/)
  assert.match(source, /showCreate \? 'Close pairing' : 'Pair executor'/)

  assert.doesNotMatch(source, /\buseLocalBack\(/)
  assert.doesNotMatch(source, /\busePhoneLayout\(/)
})

test('LOCAL_BACK_PRIORITY carries the three new stage priorities', () => {
  const source = readSource('../src/layouts/admin-shell/local-back/LocalBackContext.tsx')
  assert.match(source, /executorsCreate: 30,/)
  assert.match(source, /dashboardPanel: 30,/)
  assert.match(source, /dashboardVersions: 31,/)
})

test('the dashboard panels keep a full-height flex column with their own scroll region', () => {
  // Both panels are one `SidePanel` now (the content system's shared shell),
  // so the geometry this pins lives there rather than twice in the callers.
  for (const path of [
    '../src/components/features/dashboards/AddWidgetPanel.tsx',
    '../src/components/features/dashboards/DashboardVersionsPanel.tsx',
  ]) {
    const source = readSource(path)
    assert.match(source, /<SidePanel[\s\n]/)
    assert.match(source, /onClose=\{onClose\}/)
  }

  const shell = readSource('../src/components/shared/SidePanel.tsx')
  // `h-full min-h-0` so the aside fills the available height whether that
  // comes from flex stretch (an inline side panel beside the grid, on
  // split) or from a real definite height (a hosted, full-screen stage on
  // a phone, where the portal target is not itself a flex parent). `w-full
  // md:w-80` so the phone stage is a genuine full screen rather than a
  // 320px column with empty space beside it, while split keeps today's
  // fixed-width side placement — a pure CSS breakpoint, not a page-level
  // read of the navigation layout.
  assert.match(shell, /flex h-full min-h-0 w-full flex-col border-l[^']*md:w-80/)
  // The inner body owns its own scroll independent of the aside's height.
  assert.match(shell, /min-h-0 flex-1[^"]*overflow-y-auto/)
  // The close control is the header ✕, present regardless of layout — a
  // phone-mode full screen has no separate chrome to supply one.
  assert.match(shell, /onClick=\{onClose\}/)
})
