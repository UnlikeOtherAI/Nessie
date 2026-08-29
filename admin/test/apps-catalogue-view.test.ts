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
 * How the catalogue arranges itself. All of it derives from the one list
 * response, so switching filter or typing never waits on the network.
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

const section = (
  category: AppCategorySectionModel['category'],
  count: number,
): AppCategorySectionModel => ({
  apps: Array.from({ length: count }, (_unused, index) =>
    app({ id: `app-${index}`, displayName: `App ${index}` }),
  ),
  category,
  label: category,
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

test('sections follow the taxonomy fixed order and skip categories with nothing in them', () => {
  const sections = buildCategorySections([
    app({ id: '1', displayName: 'Notion', primaryCategory: 'productivity' }),
    app({ id: '2', displayName: 'Slack', primaryCategory: 'communication' }),
    app({ id: '3', displayName: 'Datadog', primaryCategory: 'infrastructure' }),
  ])
  // Fixed rather than sorted by count: an app must not move down the page
  // because somebody else in the organisation connected something.
  assert.deepEqual(
    sections.map((section) => section.category),
    ['communication', 'productivity', 'infrastructure'],
  )
  assert.deepEqual(
    sections.map((section) => section.label),
    ['Communication', 'Productivity', 'Infrastructure'],
  )
})

test('an app appears under its primary category only, however many it claims', () => {
  const sections = buildCategorySections([
    app({
      id: '1',
      displayName: 'GitHub',
      categories: ['development', 'project_management'],
      primaryCategory: 'development',
    }),
  ])
  // Listing it twice would double the page and make every count a lie; its
  // secondary categories still match in search.
  assert.deepEqual(
    sections.map((section) => section.category),
    ['development'],
  )
})

test('apps sort by name inside a section, so the order does not depend on the response order', () => {
  const sections = buildCategorySections([
    app({ id: '1', displayName: 'Zulip', primaryCategory: 'communication' }),
    app({ id: '2', displayName: 'Discord', primaryCategory: 'communication' }),
    app({ id: '3', displayName: 'slack', primaryCategory: 'communication' }),
  ])
  assert.deepEqual(namesOf(sections[0]?.apps ?? []), ['Discord', 'slack', 'Zulip'])
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
})

test('Other is the long tail and is always shown whole — a toggle there saves nobody anything', () => {
  const other = section('other', 20)
  assert.equal(sectionVisibleApps(other, 4, false).length, 20)
  assert.equal(sectionOffersShowAll(other, 4), false)
})

test('an empty store says so, whatever filter or query the person happens to be holding', () => {
  assert.deepEqual(
    catalogueEmptyMessage({ filter: 'installed', query: 'git', totalCount: 0 }),
    {
      actionLabel: 'Add custom app',
      message:
        'No apps have been published to your catalogue yet. '
        + 'Add any MCP-compatible server as a custom app.',
    },
  )
})

test('a query that found nothing quotes the query, and outranks the installed filter', () => {
  assert.deepEqual(catalogueEmptyMessage({ filter: 'installed', query: ' git ', totalCount: 47 }), {
    actionLabel: 'Add custom app',
    message:
      'No apps match "git". Try a different word — '
      + 'or add any MCP-compatible server as a custom app.',
  })
})

test('whitespace is not a query, so an empty Installed grid still points at All', () => {
  assert.deepEqual(catalogueEmptyMessage({ filter: 'installed', query: '   ', totalCount: 47 }), {
    actionLabel: 'Add custom app',
    message:
      "You haven't connected any apps yet. "
      + 'Switch to All to see what your team can connect.',
  })
})

test('with nothing narrowed the empty grid falls back to the footer nudge', () => {
  assert.deepEqual(
    catalogueEmptyMessage({ filter: 'all', query: '', totalCount: 47 }),
    CATALOGUE_FOOTER_NUDGE,
  )
})
