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
    backlogCount: 0,
    canManageMembers: true,
    channels: [{ id: 'c1', label: 'general' }],
    dashboards: [],
    documentsUpdatedAge: '2h',
    isScrum: false,
    memberCount: 3,
    openWorkCount: 5,
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
    // …and nothing here points at a section that does not exist. Channels and
    // People are the two deliberate non-sections: they have no route of their
    // own but the page below no longer lists them, so the grid must.
    for (const key of tileKeys) {
      if (key === 'channels' || key === 'people') continue
      if (key.startsWith('dashboard:')) continue
      assert.ok(sectionIds.includes(key), `tile "${key}" is not a project section`)
    }
    assert.ok(tileKeys.includes('channels'))
    assert.ok(tileKeys.includes('people'))
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

test('the tiles keep the sidebar order, with Channels and People before the manage-it doorways', () => {
  const keys = tiles({ isScrum: true }).map((tile) => tile.key)
  assert.deepEqual(keys, [
    'board', 'backlog', 'insights', 'docs', 'dashboards',
    'channels', 'people', 'executors', 'settings',
  ])
})

test('People opens the members dialog; every section tile is a route', () => {
  const found = tiles()
  const people = found.find((tile) => tile.key === 'people')
  assert.ok(people)
  assert.equal(people.to, undefined)
  assert.equal(people.opensMembers, true)
  // Every other tile goes somewhere, or it is a coloured square that does
  // nothing. Channels leaves the project, so it is checked on its own below.
  for (const tile of found) {
    if (tile.key === 'people' || tile.key === 'channels') continue
    assert.match(tile.to ?? '', /^\/projects\/p1(\/|$)/)
  }
})

test('Channels opens the busiest room, and says so when there is none', () => {
  const withRooms = tiles({
    channels: [{ id: 'busy', label: 'general' }, { id: 'quiet', label: 'random' }],
  }).find((tile) => tile.key === 'channels')
  assert.equal(withRooms?.to, '/channels/busy')
  assert.equal(withRooms?.meta, '2 channels')

  // Nowhere to send anybody: the tile keeps its place and explains itself
  // rather than pointing at an empty list.
  const without = tiles({ channels: [] }).find((tile) => tile.key === 'channels')
  assert.equal(without?.to, undefined)
  assert.equal(without?.meta, undefined)
  assert.match(without?.blurb ?? '', /No rooms yet/)
})

test('each tile says what is in it — once, and only where a number is honest', () => {
  const found = tiles({
    backlogCount: 4,
    dashboards: [{ id: 'd1', title: 'Revenue' }, { id: 'd2', title: 'Latency' }],
    isScrum: true,
    memberCount: 1,
    openWorkCount: 12,
  })
  const meta = (key: string) => found.find((tile) => tile.key === key)?.meta

  assert.equal(meta('board'), '12 open')
  assert.equal(meta('backlog'), '4 waiting')
  assert.equal(meta('people'), '1 person')
  assert.equal(meta('channels'), '1 channel')
  assert.equal(meta('dashboards'), '2 dashboards')
  // The recent-pages read is capped, so it knows when the newest document
  // changed but not how many exist. Recency is the honest signal.
  assert.equal(meta('docs'), 'updated 2h')
  // Nothing project-scoped to count: executors are an organisation-wide pool.
  assert.equal(meta('executors'), undefined)
  assert.equal(meta('settings'), undefined)
  assert.equal(meta('insights'), undefined)

  // Still loading, or genuinely empty: no "0 open".
  const empty = tiles({
    backlogCount: 0,
    channels: [],
    dashboards: [],
    documentsUpdatedAge: null,
    memberCount: 0,
    openWorkCount: 0,
  })
  for (const tile of empty) assert.equal(tile.meta, undefined, `${tile.key} invented a count`)
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
  assert.equal(tones.length, 8)
  for (const [, , value] of tones) assert.match(value, /^var\(--[a-z0-9-]+\)$/)
})

test('the page below the grid is two columns, and nothing a tile already says', () => {
  const dashboard = source('components/features/projects/ProjectDashboard.tsx')

  // Members used to be on this screen three times — the header button, the
  // tile, and a card. The cards a tile's count replaced are gone.
  assert.match(dashboard, /<ProjectWorkSection/)
  assert.match(dashboard, /<ProjectDocumentsSection/)
  assert.doesNotMatch(dashboard, /<ProjectMembersSection/)
  assert.doesNotMatch(dashboard, /<ProjectChannelsSection/)
  assert.doesNotMatch(dashboard, /<ProjectAgentsSection/)
  assert.match(dashboard, /className="project-overview-columns"/)
})

test('a project’s dashboards continue the grid as live tiles, after the fixed doorways', () => {
  const found = tiles({
    dashboards: [{ id: 'd1', title: 'Revenue' }, { id: 'd2', title: 'Latency' }],
  })
  const dashboardTiles = found.filter((tile) => tile.dashboardId)

  // They are tiles in the same grid rather than a band of their own, and they
  // come after every fixed doorway so that block keeps the shape a person
  // learns.
  assert.deepEqual(dashboardTiles.map((tile) => tile.label), ['Revenue', 'Latency'])
  assert.deepEqual(found.slice(-2).map((tile) => tile.dashboardId), ['d1', 'd2'])

  // Each opens the full-screen dashboard inside its own project.
  assert.deepEqual(
    dashboardTiles.map((tile) => tile.to),
    ['/projects/p1/dashboards/d1', '/projects/p1/dashboards/d2'],
  )
  // A live dashboard says what it is; a blurb under one would caption a caption.
  for (const tile of dashboardTiles) assert.equal(tile.blurb, '')
})

test('a project with no dashboards still has the doorway to make one', () => {
  const found = tiles({ dashboards: [] })
  assert.equal(found.filter((tile) => tile.dashboardId).length, 0)
  const section = found.find((tile) => tile.key === 'dashboards')
  assert.equal(section?.to, '/projects/p1/dashboards')
  // No count, rather than "0 dashboards".
  assert.equal(section?.meta, undefined)
})
