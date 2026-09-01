import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  collectRouterPaths,
  toSamplePathname,
} from '../../scripts/lint-navigation-surfaces.mjs'
import {
  OUTSIDE_STACK_PATHS,
  SURFACES,
  matchSurface,
  surfaceParent,
  surfaceScreen,
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

test('the routes outside the stack are exactly the unauthenticated ones and not-found', () => {
  assert.deepEqual(
    routerPaths.filter((routerPath) => OUTSIDE_STACK_PATHS.includes(routerPath)).sort(),
    ['*', '/bootstrap', '/login', '/login/completing'],
  )
  // They are outside deliberately: no section, no depth, no Back.
  for (const outside of OUTSIDE_STACK_PATHS) {
    if (outside === '*') continue
    assert.equal(surfaceScreen(outside), null, outside)
  }
})

test('a redirect route is listed but never classifies a screen', () => {
  const redirects = ['/', '/work', '/chats', '/workflows', '/workflows/tools', '/settings/tools', '/settings/agents', '/integrations']
  for (const pathname of redirects) {
    assert.equal(matchSurface(pathname)?.surface.type, 'redirect', pathname)
    assert.equal(surfaceScreen(pathname), null, pathname)
    assert.equal(surfaceParent(pathname), null, pathname)
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
  const roots = new Map(
    SURFACES.filter((surface) => surface.type === 'root').map((surface) => [surface.section, surface.root]),
  )
  assert.deepEqual(
    [...roots.keys()].sort(),
    ['admin', 'channels', 'knowledge', 'projects', 'search'],
  )
  for (const surface of SURFACES) {
    assert.equal(roots.get(surface.section), surface.root, String(surface.pattern))
  }
})
