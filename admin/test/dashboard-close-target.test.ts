import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { collectRouterPaths } from '../../scripts/lint-navigation-surfaces.mjs'
import { dashboardCloseTarget } from '../src/pages/channels/dashboard-close-target'

/**
 * Close on the dashboard workspace panel went to a 404.
 *
 * It navigated to `/channels/:channelId/threads/:threadId` when the panel had
 * been opened from a thread. That reads like a route and is not one: the router
 * declares the two panels that hang off a thread — `…/replies/:rootMessageId`
 * and `…/dashboards/:dashboardId` — but nothing at the bare thread itself. The
 * navigation therefore fell through to the `*` catch-all and rendered
 * NotFoundPage.
 *
 * Reading the real router is the point. A test that merely asserted the string
 * `/channels/:channelId` would have passed just as happily against the broken
 * destination.
 */

const routerPaths: string[] = collectRouterPaths(
  readFileSync(fileURLToPath(new URL('../src/router.tsx', import.meta.url)), 'utf8'),
)

test('the dashboard panel closes to a route the router actually declares', () => {
  assert.ok(routerPaths.length > 50, 'router paths were not extracted')
  // Passing the parameter name renders the destination as its route pattern.
  assert.ok(
    routerPaths.includes(dashboardCloseTarget(':channelId')),
    `close target ${dashboardCloseTarget(':channelId')} is not a declared route`,
  )
})

test('the destination is the channel, as the sibling reply panel already does', () => {
  assert.equal(dashboardCloseTarget('abc'), '/channels/abc')
})

test('the bare thread path the panel used to close to is still not a route', () => {
  // Kept as the regression's shape. Should a bare-thread route ever be added,
  // this fails and whoever adds it decides deliberately whether Close should go
  // there — rather than the panel silently starting to work again by accident.
  assert.ok(
    !routerPaths.includes('/channels/:channelId/threads/:threadId'),
    'a bare thread route now exists — revisit the dashboard panel close target',
  )
})
