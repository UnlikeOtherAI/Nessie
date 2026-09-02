import assert from 'node:assert/strict'
import test from 'node:test'

import type { AppSummaryRecord } from '@nessie/schemas'

import {
  ALL_CATEGORIES_VALUE,
  APPS_FILTER_STORAGE_KEY,
  APP_GRID_CLASS,
  appCategoryOptions,
  appFilterOptions,
  appGridColumns,
  buildCategorySections,
  CATALOGUE_FOOTER_NUDGE,
  catalogueEmptyMessage,
  filterApps,
  installedShelf,
  isInstalledApp,
  parseAppFilter,
  readStoredAppFilter,
  sectionOffersShowAll,
  sectionPageSize,
  sectionRemainingLabel,
  sectionToggleLabel,
  sectionVisibleApps,
  shelfKey,
  visibleShelves,
  writeStoredAppFilter,
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

test('the selected catalogue filter is retained for the next clean Apps visit', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => { values.set(key, value) },
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })

  try {
    assert.equal(readStoredAppFilter(), 'all')
    writeStoredAppFilter('installed')
    assert.equal(values.get(APPS_FILTER_STORAGE_KEY), 'installed')
    assert.equal(readStoredAppFilter(), 'installed')
    writeStoredAppFilter('all')
    assert.equal(readStoredAppFilter(), 'all')
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
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
      actions: [{ id: 'add-custom', label: 'Add custom app' }],
      message:
        'No apps have been published to your catalogue yet. '
        + 'Connect a tool by its address to add the first one.',
    },
  )
})

test('a search inside Installed says which set it searched, and offers the other one', () => {
  // It used to report the flat "No apps match" — true of the six connected
  // apps, and read by everybody as true of the catalogue, which is where the
  // app they were after usually is.
  assert.deepEqual(catalogueEmptyMessage({ filter: 'installed', query: ' git ', totalCount: 47 }), {
    actions: [
      { id: 'browse-all', label: 'Search all apps' },
      { id: 'add-custom', label: 'Add custom app' },
    ],
    message: 'None of your installed apps match "git".',
  })
})

test('a query that found nothing across the catalogue quotes the query', () => {
  assert.deepEqual(catalogueEmptyMessage({ filter: 'all', query: ' git ', totalCount: 47 }), {
    actions: [{ id: 'add-custom', label: 'Add custom app' }],
    message:
      'No apps match "git". Try a different word — '
      + 'or connect a tool by its address.',
  })
})

test('whitespace is not a query, so an empty Installed grid describes the state it is in', () => {
  // It used to instruct "Switch to All" while the only button read "Add custom
  // app" — an instruction that was not clickable beside a control that did
  // something else. Browsing the catalogue is now the button it names.
  assert.deepEqual(catalogueEmptyMessage({ filter: 'installed', query: '   ', totalCount: 47 }), {
    actions: [
      { id: 'browse-all', label: 'Browse all apps' },
      { id: 'add-custom', label: 'Add custom app' },
    ],
    message: "You haven't connected any apps yet.",
  })
})

test('with nothing narrowed the empty grid says what the footer nudge says, once', () => {
  // The page renders one or the other, never both: the footer nudge is
  // suppressed under an empty grid, where it would restate the empty state's
  // own sentence and button one line lower.
  assert.deepEqual(catalogueEmptyMessage({ filter: 'all', query: '', totalCount: 47 }), {
    actions: [{ id: 'add-custom', label: 'Add custom app' }],
    message: CATALOGUE_FOOTER_NUDGE.message,
  })
  assert.deepEqual(CATALOGUE_FOOTER_NUDGE, {
    actionLabel: 'Add custom app',
    message: "Can't find what you need? Connect a tool by its address.",
  })
})

test('Installed is one shelf spanning every category, counted by the server', () => {
  // Category headings are how a person browses thousands of apps; they are not
  // how anybody reads their own three. The shelf is flat, and its total is
  // `installedCount` — the aggregate over the whole installed set — so paging
  // it stays honest while the response carries one bounded page.
  const shelf = installedShelf([app({ id: 'a' }), app({ id: 'b' })], 57)

  assert.equal(shelf.category, null)
  assert.equal(shelf.label, 'Installed')
  assert.equal(shelf.total, 57)
  assert.equal(shelfKey(shelf), 'installed')
  assert.equal(shelfKey({ category: 'development' }), 'development')
  assert.equal(sectionRemainingLabel(shelf.apps.length, shelf.total), 'Load more (55 left)')
})

test('the category dropdown opens on All, then the taxonomy in its fixed order', () => {
  const options = appCategoryOptions([
    section('communication', 3, 35),
    section('development', 2, 23),
    section('other', 1, 512),
  ])

  assert.deepEqual(options, [
    { label: 'All categories', value: ALL_CATEGORIES_VALUE },
    { label: 'communication (35)', value: 'communication' },
    { label: 'development (23)', value: 'development' },
    { label: 'other (512)', value: 'other' },
  ])
})

test('the All option carries no count, because the filter beside it already shows that total', () => {
  // Two adjacent controls both reading "All (1092)" said nothing about which
  // one narrowed what. Counts stay on the categories, where they name a real
  // choice; and every count is the server's total, never the loaded slice.
  const [all, communication] = appCategoryOptions([section('communication', 3, 35)])

  assert.equal(all?.label, 'All categories')
  assert.equal(communication?.label, 'communication (35)')
})

test('narrowing to a category leaves that shelf and no other', () => {
  // The server keeps counting every category while `?category=` narrows the
  // slice, so the dropdown can offer the ones you are not looking at. The page
  // rendered a section per *counted* category, so picking Communication still
  // painted every other heading and pushed the apps below the fold.
  const sections = [
    section('communication', 3, 150),
    section('development', 0, 73),
    section('other', 0, 512),
  ]

  assert.deepEqual(
    visibleShelves(sections, 'communication').map((s) => s.category),
    ['communication'],
  )
  // Unnarrowed, every shelf still shows — this is a narrowing, not a rewrite.
  assert.equal(visibleShelves(sections, null).length, 3)
})
