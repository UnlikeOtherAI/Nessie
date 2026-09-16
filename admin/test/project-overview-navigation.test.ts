import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  projectNavigationTiles,
} from '../src/components/features/projects/project-navigation-tiles'
import { projectSections } from '../src/navigation/project-sections'

/**
 * A project's Overview is a doorway. These pin the two things that make it
 * one: every section of the project is reachable from it, and the page is
 * painted as navigation rather than as a work surface.
 */

const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8')

const tiles = (overrides: Partial<Parameters<typeof projectNavigationTiles>[0]> = {}) =>
  projectNavigationTiles({
    boardCount: 1,
    canManageMembers: true,
    isScrum: false,
    memberCount: 3,
    projectId: 'p1',
    ...overrides,
  })

test('every section of the project has a tile, and Overview does not link to itself', () => {
  for (const isScrum of [false, true]) {
    const sectionIds = projectSections({ isScrum, projectId: 'p1' })
      .map((section) => section.id)
      .filter((id) => id !== 'overview')
    const tileKeys = tiles({ isScrum }).map((tile) => tile.key)

    // Nothing the sidebar offers is missing here…
    for (const id of sectionIds) assert.ok(tileKeys.includes(id), `no tile for "${id}"`)
    // …and nothing here points at a section that does not exist.
    for (const key of tileKeys) {
      if (key === 'people') continue
      assert.ok(sectionIds.includes(key), `tile "${key}" is not a project section`)
    }
    assert.ok(!tileKeys.includes('overview' as never))
  }
})

test('a scrum project gains Backlog and Insights, a kanban one does not', () => {
  const kanban = tiles({ isScrum: false }).map((tile) => tile.key)
  const scrum = tiles({ isScrum: true }).map((tile) => tile.key)

  assert.ok(!kanban.includes('backlog'))
  assert.ok(!kanban.includes('insights'))
  assert.ok(scrum.includes('backlog'))
  assert.ok(scrum.includes('insights'))
})

test('the tiles keep the sidebar order, with People before the manage-it doorways', () => {
  const keys = tiles({ isScrum: true }).map((tile) => tile.key)
  assert.deepEqual(keys, ['board', 'backlog', 'insights', 'docs', 'people', 'executors', 'settings'])
})

test('People is the one tile that does not navigate', () => {
  const found = tiles()
  const people = found.find((tile) => tile.key === 'people')
  assert.ok(people)
  assert.equal(people.to, undefined)
  // Everything else must, or it is a coloured square that does nothing.
  for (const tile of found) {
    if (tile.key === 'people') continue
    assert.match(tile.to ?? '', /^\/projects\/p1(\/|$)/)
  }
})

test('a tile counts what is behind it, and says nothing when there is nothing to count', () => {
  const withCounts = tiles({ boardCount: 3, memberCount: 1 })
  assert.equal(withCounts.find((tile) => tile.key === 'board')?.meta, '3 boards')
  assert.equal(withCounts.find((tile) => tile.key === 'people')?.meta, '1 person')

  // Still loading, or genuinely empty: no "0 boards".
  const empty = tiles({ boardCount: 0, memberCount: 0 })
  assert.equal(empty.find((tile) => tile.key === 'board')?.meta, undefined)
  assert.equal(empty.find((tile) => tile.key === 'people')?.meta, undefined)
})

test('the People tile says what the reader may actually do', () => {
  assert.match(
    tiles({ canManageMembers: true }).find((tile) => tile.key === 'people')?.blurb ?? '',
    /Add and remove/,
  )
  assert.doesNotMatch(
    tiles({ canManageMembers: false }).find((tile) => tile.key === 'people')?.blurb ?? '',
    /Add and remove/,
  )
})

test('the sidebar’s label counts stay out of the tiles', () => {
  // `projectSections` appends "(n)" to Boards and Docs when it is given
  // counts. The grid carries its own, so it must not ask for those.
  for (const tile of tiles()) assert.doesNotMatch(tile.label, /\(\d+\)/)
})

test('Overview is painted as navigation, and only Overview is', () => {
  const view = source('pages/project/ProjectView.tsx')
  const channelsHost = source('pages/channels/ChannelProjectOverviewPage.tsx')
  const dashboard = source('components/features/projects/ProjectDashboard.tsx')

  // The surface class is on each host's outer section, so the project header
  // is painted with the body it titles rather than left as a white band above
  // a navy page.
  assert.match(view, /tab === 'overview' \? 'admin-nav-surface' : ''/)
  assert.match(channelsHost, /className="admin-nav-surface flex h-full min-h-0 flex-col"/)
  // Not on the dashboard itself: it would then paint the settings and board
  // tabs too, which are work surfaces.
  assert.doesNotMatch(dashboard, /className=[^\n]*admin-nav-surface/)
})

test('the navigational palette is scoped with the chrome it borrows', () => {
  const styles = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8')

  // In the default theme the navy palette exists only on the chrome, so the
  // page has to be listed with the topbar and the sidebars to reach it.
  assert.match(
    styles,
    /:where\(\[data-theme="nessie"\]\) \.admin-nav-surface:not\(\.focus-mode \*\):not\(\.overlays-focus-mode \*\)/,
  )
  // Focus mode is monochrome by contract; the tiles give up their hues too.
  assert.match(styles, /\.focus-mode \.project-nav-tile,/)
  // Every tone resolves to a token — no raw colour on this surface.
  const tones = [...styles.matchAll(/\.project-nav-tile\[data-tone='([a-z]+)'\] \{ --tile: ([^;]+); \}/g)]
  assert.equal(tones.length, 7)
  for (const [, , value] of tones) assert.match(value, /^var\(--[a-z0-9-]+\)$/)
})
