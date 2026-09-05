import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Route-level code splitting gate
 * (docs/plans/2026-09-05-admin-architecture-review/audit/05-pages-routing.md F1,
 * audit/09-boundary-errors-tests.md F5).
 *
 * router.tsx statically imports only the pages a session needs before the
 * shell can even decide where to send it: the auth gate (`LoginRoute`,
 * `BootstrapPage`, `ExternalAuthCompletionPage`), the catch-all
 * (`NotFoundPage`), and `ChannelsPage` — the first screen almost every
 * session lands on. Everything else is `React.lazy`, routed through the
 * router's one `lazyElement` Suspense wrapper (fallback: the shared
 * `Skeleton` primitive, never a second `<h1>` — docs/navigation/verification-
 * and-settle.md §12, §3). This walks the router source as text and holds
 * both lists exact in both directions: the eager set can only shrink on
 * purpose, and a new lazy route must go through `lazyElement`.
 *
 * `RootLayout` and `AdminShellLayout` are eager too, but they live under
 * `./layouts/`, not `./pages/`, so they are out of this file's `./pages/...`
 * scope — they are covered instead by the "direct JSX element" checks below.
 */

const ROUTER_PATH = fileURLToPath(new URL('../src/router.tsx', import.meta.url))
const source = readFileSync(ROUTER_PATH, 'utf8')

const EAGER_PAGES = ['BootstrapPage', 'ChannelsPage', 'ExternalAuthCompletionPage', 'LoginRoute', 'NotFoundPage']

// Non-page structural elements a route may reference directly (never through
// lazyElement): the two eager layouts, the redirect primitive, and the two
// local redirect components declared in this file.
const ALLOWED_DIRECT_ELEMENTS = [
  ...EAGER_PAGES,
  'AdminShellLayout',
  'RedirectRoute',
  'RootLayout',
  'RootRouteRedirect',
  'SettingsRootRoute',
]

const staticPageImports = [...source.matchAll(
  /^import\s+\{\s*([A-Za-z0-9_]+)\s*\}\s+from\s+'(\.\/pages\/[^']+)'/gm,
)].map((match) => ({ name: match[1], path: match[2] }))

test('every statically imported ./pages/... module is on the eager allowlist, and vice versa', () => {
  const names = staticPageImports.map((entry) => entry.name)
  assert.deepEqual(names.slice().sort(), EAGER_PAGES.slice().sort())
})

test('each eager page is imported from the page file that shares its name', () => {
  for (const entry of staticPageImports) {
    assert.ok(
      entry.path === `./pages/${entry.name}` || entry.path.endsWith(`/${entry.name}`),
      `${entry.name}: imported from ${entry.path}, expected a matching ./pages/... path`,
    )
  }
})

// Every `const X = lazy(() => import('./pages/...').then((m) => ({ default: m.X })))`
// declaration. Found by anchoring on `const X = lazy(` and then reading the
// import path and default-export name out of a bounded window after it,
// rather than one regex spanning the whole (sometimes multi-line) call —
// prettier wraps some of these across three lines and not others.
type LazyDecl = { exportName: string | null; name: string; path: string | null }

const lazyDeclarations: LazyDecl[] = [...source.matchAll(/const\s+([A-Za-z0-9_]+)\s*=\s*lazy\(/g)].map(
  (match) => {
    const name = match[1]
    const window = source.slice(match.index ?? 0, (match.index ?? 0) + 300)
    const pathMatch = window.match(/import\('([^']+)'\)/)
    const exportMatch = window.match(/default:\s*m\.([A-Za-z0-9_]+)/)
    return { exportName: exportMatch?.[1] ?? null, name, path: pathMatch?.[1] ?? null }
  },
)

test('the router declares a substantial number of lazy pages', () => {
  assert.ok(lazyDeclarations.length > 20, `expected many lazily-loaded pages, found ${lazyDeclarations.length}`)
})

test('every lazy declaration imports from ./pages/... and re-exports the name it binds', () => {
  for (const decl of lazyDeclarations) {
    assert.ok(decl.path, `${decl.name}: could not find its dynamic import('./pages/...') call`)
    assert.ok(decl.path?.startsWith('./pages/'), `${decl.name}: lazy import must come from ./pages/..., got ${decl.path}`)
    assert.equal(decl.exportName, decl.name, `${decl.name}: must bind the named export it re-exports as default`)
  }
})

test('no page name is both statically imported and lazily declared', () => {
  const eagerNames = new Set(staticPageImports.map((entry) => entry.name))
  const overlap = lazyDeclarations.map((decl) => decl.name).filter((name) => eagerNames.has(name))
  assert.deepEqual(overlap, [])
})

test('every lazily declared page is wrapped by lazyElement somewhere in the router', () => {
  const missing = lazyDeclarations
    .map((decl) => decl.name)
    .filter((name) => !new RegExp(`lazyElement\\(${name},`).test(source))
  assert.deepEqual(
    missing,
    [],
    `${missing.join(', ')}: declared via lazy() but never passed to lazyElement — dead import or a route `
    + 'still rendering it as bare JSX',
  )
})

test('lazyElement is never called with a component that was not declared via lazy()', () => {
  const lazyNames = new Set(lazyDeclarations.map((decl) => decl.name))
  const offenders = [...source.matchAll(/lazyElement\(([A-Za-z0-9_]+),/g)]
    .map((match) => match[1])
    .filter((name) => !lazyNames.has(name))
  assert.deepEqual(offenders, [], `${offenders.join(', ')}: passed to lazyElement without a lazy() declaration`)
})

test('no route renders a page directly as JSX; only layouts, redirects and eager pages may', () => {
  const offenders = [...source.matchAll(/element:\s*<([A-Za-z0-9_]+)/g)]
    .map((match) => match[1])
    .filter((name) => !ALLOWED_DIRECT_ELEMENTS.includes(name))
  assert.deepEqual(
    offenders,
    [],
    `${offenders.join(', ')}: rendered as bare JSX in a route's \`element\`. A page that is not on the `
    + 'eager allowlist must be declared with lazy() and rendered through lazyElement(...).',
  )
})

test('the Suspense fallback renders Skeleton and never a second <h1>', () => {
  const fallbackMatch = source.match(/const lazyElement[\s\S]*?\n\)\n/)
  assert.ok(fallbackMatch, 'lazyElement wrapper definition not found in router.tsx')
  const body = fallbackMatch[0]
  assert.match(body, /<Suspense fallback=\{routeLoading\(variant\)\}>/)
  const loadingMatch = source.match(/const routeLoading[\s\S]*?\n\)\n/)
  assert.ok(loadingMatch, 'routeLoading fallback definition not found in router.tsx')
  assert.match(loadingMatch[0], /data-route-loading=""/)
  assert.match(loadingMatch[0], /<Skeleton variant=\{variant\} \/>/)
  assert.doesNotMatch(loadingMatch[0], /<h1/)
  assert.doesNotMatch(body, /<h1/)
})
