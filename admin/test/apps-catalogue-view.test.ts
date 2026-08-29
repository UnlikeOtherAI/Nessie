import assert from 'node:assert/strict'
import test from 'node:test'

import type { AppSummaryRecord } from '@nessie/schemas'

import {
  APP_GRID_CLASS,
  appFilterOptions,
  appGridColumns,
  buildCategorySections,
  CATALOGUE_FOOTER_NUDGE,
  catalogueEmptyMessage,
  filterApps,
  isInstalledApp,
  parseAppFilter,
  sectionOffersShowAll,
  sectionPageSize,
  sectionToggleLabel,
  sectionVisibleApps,
  type AppCategorySectionModel,
  type AppGridBreakpointMatches,
} from '../src/components/features/apps/app-catalogue-view.js'

/**
 * How the catalogue arranges itself: which apps a section holds, how much of it
 * a person sees before asking for the rest, and what an empty grid says.
 *
 * The shaping is local, the facts are not. `apps` is a bounded slice of a
 * catalogue holding thousands, so every count asserted here comes from the
 * server's aggregates and never from the length of the array beside it.
 */

const app = (overrides: Partial<AppSummaryRecord> = {}): AppSummaryRecord => ({
  aliases: [],
  appSource: 'nessie',
  categories: ['development'],
  connectionCount: 0,
  displayName: 'GitHub',
  distribution: 'remote',
  featured: false,
  featuredOrder: null,
  iconUrl: null,
  id: 'app-1',
  installHref: '/install/app-1',
  locked: false,
  managedByIntegration: false,
  name: 'github',
  primaryCategory: 'development',
  promptCount: null,
  resourceCount: null,
  shortDescription: '',
  slug: 'github',
  state: 'available',
  tags: [],
  toolCount: null,
  trustLevel: 'verified',
  vendor: null,
  ...overrides,
})

const breakpoints = (
  overrides: Partial<AppGridBreakpointMatches> = {},
): AppGridBreakpointMatches => ({
  twoColumns: false,
  threeColumns: false,
  fourColumns: false,
  fiveColumns: false,
  ...overrides,
})

const namesOf = (apps: readonly AppSummaryRecord[]): string[] =>
  apps.map((entry) => entry.displayName)

/**
 * `loaded` is how many cards this page carried; `total` is what SQL counted
 * over the unsliced category. They are the same number only when the whole
 * category fits on one page.
 */
const section = (
  category: AppCategorySectionModel['category'],
  loaded: number,
  total: number = loaded,
): AppCategorySectionModel => ({
  apps: Array.from({ length: loaded }, (_unused, index) =>
    app({ id: `app-${index}`, displayName: `App ${index}` }),
  ),
  category,
  label: category,
  total,
})

test('an unrecognised filter in the URL falls back to All rather than emptying the grid', () => {
  assert.equal(parseAppFilter(null), 'all')
  assert.equal(parseAppFilter('installed'), 'installed')
  assert.equal(parseAppFilter('Installed'), 'all')
  assert.equal(parseAppFilter('featured'), 'all')
})

test('installed means this caller can see a connection, not that the tenant holds one', () => {
  assert.equal(isInstalledApp(app({ connectionCount: 0 })), false)
  assert.equal(isInstalledApp(app({ connectionCount: 1 })), true)

  const apps = [app({ id: 'a', connectionCount: 2 }), app({ id: 'b' })]
  assert.deepEqual(
    filterApps(apps, 'installed').map((entry) => entry.id),
    ['a'],
  )
  const all = filterApps(apps, 'all')
  assert.deepEqual(all, apps)
  // A copy, so a caller sorting the result cannot reorder the query cache.
  assert.notStrictEqual(all, apps)
})

test('filter counts come from the server totals, so All 47 stays 47 while a search narrows', () => {
  assert.deepEqual(appFilterOptions({ installedCount: 3, totalCount: 47 }), [
    { count: 47, label: 'All', value: 'all' },
    { count: 3, label: 'Installed', value: 'installed' },
  ])
})

test('the column ladder reports the same counts the grid classes actually render', () => {
  assert.equal(appGridColumns(breakpoints()), 1)
  assert.equal(appGridColumns(breakpoints({ twoColumns: true })), 2)
  assert.equal(appGridColumns(breakpoints({ twoColumns: true, threeColumns: true })), 3)
  assert.equal(
    appGridColumns(breakpoints({ twoColumns: true, threeColumns: true, fourColumns: true })),
    4,
  )
  assert.equal(appGridColumns(breakpoints({ fiveColumns: true })), 5)

  // "Show the first two rows" is computed from the layout that rendered, so the
  // two have to change together.
  for (const columns of [1, 2, 3, 4, 5]) {
    assert.ok(APP_GRID_CLASS.includes(`grid-cols-${columns}`), `grid-cols-${columns}`)
  }
})

test('a section pages after two rows, and a zero-column measurement still shows something', () => {
  assert.equal(sectionPageSize(4), 8)
  assert.equal(sectionPageSize(1), 2)
  assert.equal(sectionPageSize(0), 2)
})

test('the server counts decide which sections exist, including one whose cards did not fit', () => {
  const sections = buildCategorySections(
    [
      app({ id: '1', displayName: 'Notion', primaryCategory: 'productivity' }),
      app({ id: '2', displayName: 'Slack', primaryCategory: 'communication' }),
    ],
    // Sent in the taxonomy's fixed order, so an app does not move down the page
    // because somebody else in the organisation connected something.
    [
      { category: 'communication', label: 'Communication', count: 4 },
      { category: 'productivity', label: 'Productivity', count: 412 },
      { category: 'infrastructure', label: 'Infrastructure', count: 37 },
    ],
  )
  assert.deepEqual(
    sections.map((section) => section.category),
    ['communication', 'productivity', 'infrastructure'],
  )
  // Labelled by the server from the one taxonomy constant, so a heading can
  // never name a different category than the count beside it.
  assert.deepEqual(
    sections.map((section) => section.label),
    ['Communication', 'Productivity', 'Infrastructure'],
  )
  // Infrastructure is a real shelf with none of its 37 apps on this page.
  // Deriving the set from the slice would have dropped it silently.
  assert.deepEqual(
    sections.map((section) => section.apps.length),
    [1, 1, 0],
  )
  // What exists, counted in SQL — never `apps.length`, which is what arrived.
  assert.deepEqual(
    sections.map((section) => section.total),
    [4, 412, 37],
  )
})

test('an app appears under its primary category only, however many it claims', () => {
  const sections = buildCategorySections(
    [
      app({
        id: '1',
        displayName: 'GitHub',
        categories: ['development', 'project_management'],
        primaryCategory: 'development',
      }),
    ],
    [
      { category: 'development', label: 'Development', count: 1 },
      { category: 'project_management', label: 'Project Management', count: 8 },
    ],
  )
  // Listing it twice would double the page and make every count a lie; its
  // secondary categories still match in search.
  assert.deepEqual(
    sections.map((section) => section.apps.map((entry) => entry.id)),
    [['1'], []],
  )
})

test('cards keep the order the server sent, because that is the order paging cuts on', () => {
  const sections = buildCategorySections(
    [
      app({ id: '1', displayName: 'Zulip', primaryCategory: 'communication' }),
      app({ id: '2', displayName: 'Discord', primaryCategory: 'communication' }),
      app({ id: '3', displayName: 'slack', primaryCategory: 'communication' }),
    ],
    [{ category: 'communication', label: 'Communication', count: 3 }],
  )
  // Re-sorting a bounded slice would make the boundary between page one and
  // page two meaningless: the alphabet is not what the server cut on.
  assert.deepEqual(namesOf(sections[0]?.apps ?? []), ['Zulip', 'Discord', 'slack'])
})

test('a section longer than a page truncates to it and offers to show the rest', () => {
  const dev = section('development', 9)
  assert.equal(sectionVisibleApps(dev, 4, false).length, 4)
  assert.equal(sectionVisibleApps(dev, 4, true).length, 9)
  assert.equal(sectionOffersShowAll(dev, 4), true)
  assert.equal(sectionToggleLabel(dev, false), 'Show all 9 →')
  assert.equal(sectionToggleLabel(dev, true), 'Show less ↑')
})

test('a section that already fits offers no toggle', () => {
  const dev = section('development', 4)
  assert.deepEqual(sectionVisibleApps(dev, 4, false), dev.apps)
  assert.equal(sectionOffersShowAll(dev, 4), false)

  // "Fits" is decided against the SQL total, never the slice: twelve arrived
  // cards of a 412-app category fill the shelf and there is plainly more.
  const sliced = section('development', 12, 412)
  assert.equal(sectionOffersShowAll(sliced, 4), true)
  assert.equal(sectionToggleLabel(sliced, false), 'Show all 412 →')
})

test('Other pages like every other shelf — ingestion made it the largest, not the shortest', () => {
  // It used to be exempt on the grounds that the long tail is short. Registry
  // ingestion inverted that: uncategorised is now the shelf that most needs it.
  const other = section('other', 20, 3184)
  assert.equal(sectionVisibleApps(other, 4, false).length, 4)
  assert.equal(sectionVisibleApps(other, 4, true).length, 20)
  assert.equal(sectionOffersShowAll(other, 4), true)
  assert.equal(sectionToggleLabel(other, false), 'Show all 3184 →')
})

test('an empty store says so, whatever filter or query the person happens to be holding', () => {
  // The protocol's name is gone from every one of these: a person who has just
  // failed to find what they came for is not the audience for "MCP".
  assert.deepEqual(
    catalogueEmptyMessage({ filter: 'installed', query: 'git', totalCount: 0 }),
    {
      actionLabel: 'Add custom app',
      message:
        'No apps have been published to your catalogue yet. '
        + 'Connect a tool by its address to add the first one.',
    },
  )
})

test('a query that found nothing quotes the query, and outranks the installed filter', () => {
  assert.deepEqual(catalogueEmptyMessage({ filter: 'installed', query: ' git ', totalCount: 47 }), {
    actionLabel: 'Add custom app',
    message:
      'No apps match "git". Try a different word — '
      + 'or connect a tool by its address.',
  })
})

test('whitespace is not a query, so an empty Installed grid describes the state it is in', () => {
  // It used to instruct "Switch to All" while the only button read "Add custom
  // app" — an instruction that was not clickable beside a control that did
  // something else. The words now name the button's own action.
  assert.deepEqual(catalogueEmptyMessage({ filter: 'installed', query: '   ', totalCount: 47 }), {
    actionLabel: 'Add custom app',
    message:
      "You haven't connected any apps yet. Browse the catalogue with the All "
      + 'filter above, or connect a tool by its address.',
  })
})

test('with nothing narrowed the empty grid falls back to the footer nudge', () => {
  assert.deepEqual(
    catalogueEmptyMessage({ filter: 'all', query: '', totalCount: 47 }),
    CATALOGUE_FOOTER_NUDGE,
  )
  assert.deepEqual(CATALOGUE_FOOTER_NUDGE, {
    actionLabel: 'Add custom app',
    message: "Can't find what you need? Connect a tool by its address.",
  })
})
