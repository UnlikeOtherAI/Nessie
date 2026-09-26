import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  collectRouterPaths,
  findDeadPatterns,
  findShadowedPaths,
  SHADOWED_PATHS,
  toSamplePathname,
} from '../../scripts/lint-navigation-surfaces.mjs'
import { surfaceParent, surfaceScreen } from '../src/navigation/surface-lookup'
import {
  OUTSIDE_STACK_PATHS,
  SURFACES,
  matchSurface,
} from '../src/navigation/surfaces'

// The registry is total: this reads the real router and runs the real
// classifier over it. `scripts/lint-navigation-surfaces.mjs` asserts the same
// thing textually so the gate also runs in `pnpm lint`, without a TS loader.
const routerSource = readFileSync(
  fileURLToPath(new URL('../src/router.tsx', import.meta.url)),
  'utf8',
)
const routerPaths: string[] = collectRouterPaths(routerSource)
const classifiedPaths = routerPaths.filter((routerPath) => !OUTSIDE_STACK_PATHS.includes(routerPath))

test('every route in router.tsx resolves to a surface row', () => {
  assert.ok(routerPaths.length > 50, 'router paths were not extracted')
  const unclassified = classifiedPaths.filter(
    (routerPath) => matchSurface(toSamplePathname(routerPath)) === null,
  )
  assert.deepEqual(unclassified, [])
})

test('every surface row matches at least one router path (no dead rows)', () => {
  const patterns = SURFACES.map((surface) => surface.pattern)
  const dead = findDeadPatterns(patterns, routerPaths)
  assert.deepEqual(dead.map((pattern) => pattern.source), [])
})

test('a router path matched by more than one surface row is a seeded shadow', () => {
  // `matchSurface` is first-match-wins: a route matched by two rows depends
  // on array order alone. SHADOWED_PATHS in the lint script is the allowlist
  // of intentional ones; this fails if a new overlap appears unseeded, or if
  // a seeded entry no longer overlaps (the list should only shrink).
  const patterns = SURFACES.map((surface) => surface.pattern)
  const outside = new Set(OUTSIDE_STACK_PATHS)
  const shadowed = findShadowedPaths(routerPaths, patterns, outside)
  assert.deepEqual([...shadowed.keys()].sort(), [...SHADOWED_PATHS].sort())
})

// A closed list on purpose: "outside the stack" is where an unclassified route
// would land silently, so each member is named here as well as in the registry.
// The document window is the one authenticated screen among them — a whole OS
// window holding one document, with no section to light, no depth and no Back.
test('the routes outside the stack are the unauthenticated ones, not-found, and the document window', () => {
  assert.deepEqual(
    routerPaths.filter((routerPath) => OUTSIDE_STACK_PATHS.includes(routerPath)).sort(),
    ['*', '/bootstrap', '/documents/:spaceId/:pageId', '/login', '/login/completing'],
  )
  // They are outside deliberately: no section, no depth, no Back.
  for (const outside of OUTSIDE_STACK_PATHS) {
    if (outside === '*') continue
    assert.equal(surfaceScreen(outside), null, outside)
  }
})

test('a redirect route is listed but never classifies a screen', () => {
  // The landing route is the only one left: retired addresses are deleted,
  // never forwarded, so they match nothing at all.
  assert.equal(matchSurface('/')?.surface.type, 'redirect')
  assert.equal(surfaceScreen('/'), null)
  assert.equal(surfaceParent('/'), null)
  assert.deepEqual(
    SURFACES.filter((surface) => surface.type === 'redirect').map((surface) => surface.pattern.source),
    ['^\\/$'],
  )
  for (const retired of [
    '/work', '/chats', '/workflows', '/settings/tools', '/settings/account', '/agents', '/agents/a1',
    '/apps', '/tokens', '/audit', '/policy', '/ops', '/ops/usage', '/settings/members',
  ]) {
    assert.equal(matchSurface(retired), null, retired)
  }
})

test('every classified screen deeper than its root names the screen Back returns to', () => {
  for (const routerPath of classifiedPaths) {
    const pathname = toSamplePathname(routerPath)
    const screen = surfaceScreen(pathname)
    if (!screen) continue
    if (screen.depth === 0) {
      assert.equal(surfaceParent(pathname), null, `${pathname} is a root and shows the menu`)
      continue
    }
    const parent = surfaceParent(pathname)
    assert.ok(parent, `${pathname} (depth ${screen.depth}) has no Back destination`)
    assert.notEqual(parent?.pathname, pathname, `${pathname} is its own parent`)
    assert.ok(parent?.label, `${pathname} has an unlabelled Back`)
  }
})

test('a parent is itself a classified screen, so Back can never land nowhere', () => {
  for (const surface of SURFACES) {
    if (surface.type === 'redirect' || !surface.parentOf) continue
    const parent = surface.parentOf(['', 'sample-id', 'sample-id', 'sample-id'] as unknown as RegExpMatchArray)
    assert.ok(surfaceScreen(parent.pathname), `${parent.pathname} is not a screen`)
  }
})

test('one section owns each row, and a root exists for every section in use', () => {
  const roots = new Map<string, Set<string>>()
  for (const surface of SURFACES.filter((row) => row.type === 'root')) {
    roots.set(surface.section, (roots.get(surface.section) ?? new Set()).add(surface.root))
  }
  assert.deepEqual(
    [...roots.keys()].sort(),
    ['admin', 'channels', 'knowledge', 'projects', 'search'],
  )
  for (const surface of SURFACES) {
    assert.ok(roots.get(surface.section)?.has(surface.root), String(surface.pattern))
  }
  // Every section has exactly one root but Admin, which carries Your settings
  // too: the section ids are a wire contract with the native shells, so the
  // avatar menu's pages keep the Admin id under a root of their own.
  assert.deepEqual([...roots.get('admin') ?? []].sort(), ['/admin', '/settings'])
  for (const section of ['channels', 'knowledge', 'projects', 'search']) {
    assert.equal(roots.get(section)?.size, 1, section)
  }
  for (const surface of SURFACES) {
    const settingsRow = surface.pattern.source.startsWith(String.raw`^\/settings`)
    assert.equal(surface.root === '/settings', settingsRow, String(surface.pattern))
  }
})
