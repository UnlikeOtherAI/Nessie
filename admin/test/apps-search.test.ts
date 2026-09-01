import assert from 'node:assert/strict'
import test from 'node:test'

import type { AppSummaryRecord } from '@nessie/schemas'

import {
  APP_SEARCH_MIN_LENGTH,
  describeSearchResults,
  highlightSegments,
  isAppSearchActive,
  searchProvenance,
  searchResultsLabel,
} from '../src/components/features/apps/app-search.js'

/**
 * The server decides what matches and in what order — Postgres holds the
 * weighted `search_vector` plus a pg_trgm fallback. These helpers only explain
 * the answer it gave, so the load-bearing property is that they change nothing
 * about the set or the order.
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
  shortDescription: 'Repositories, issues and pull requests.',
  slug: 'github',
  state: 'available',
  tags: [],
  toolCount: null,
  trustLevel: 'verified',
  vendor: null,
  ...overrides,
})

test('one letter does not search — it would match half the store', () => {
  assert.equal(APP_SEARCH_MIN_LENGTH, 2)
  assert.equal(isAppSearchActive('g'), false)
  assert.equal(isAppSearchActive(' g '), false)
  assert.equal(isAppSearchActive('gi'), true)
  assert.equal(isAppSearchActive('  gi  '), true)
  assert.deepEqual(describeSearchResults([app()], 'g'), [])
})

test('describeSearchResults preserves the server order and drops nothing it cannot explain', () => {
  // "githb" reaches GitHub only through trigram similarity, and no substring
  // test on the loaded record reproduces that. Re-scoring here would make the
  // one row the person was looking for vanish.
  const fuzzy = app({ id: 'fuzzy', displayName: 'GitHub', name: 'github' })
  const results = describeSearchResults(
    [app({ id: 'first', displayName: 'Zulip', name: 'zulip' }), fuzzy],
    'githb',
  )
  assert.deepEqual(
    results.map((result) => result.app.id),
    ['first', 'fuzzy'],
  )
  assert.deepEqual(
    results.map((result) => result.tier),
    ['other', 'other'],
  )
})

test('the tier names where the query is visible, in the order the server weights them', () => {
  const tierOf = (overrides: Partial<AppSummaryRecord>, query: string): string =>
    describeSearchResults([app(overrides)], query)[0]?.tier ?? 'missing'

  // Name outranks an alias that also holds the word.
  assert.equal(tierOf({ aliases: ['github'] }, 'github'), 'name')
  // The internal name counts too, not only the display name.
  assert.equal(tierOf({ displayName: 'Source Control', name: 'github' }, 'github'), 'name')
  assert.equal(
    tierOf({ aliases: ['pentest'], displayName: 'Burp', name: 'burp', vendor: 'Pentest Ltd' }, 'pentest'),
    'alias',
  )
  assert.equal(tierOf({ tags: ['acme'], vendor: 'Acme' }, 'acme'), 'provider')
  assert.equal(tierOf({ displayName: 'Burp', name: 'burp', tags: ['scanner'] }, 'scanner'), 'tag')
})

test('a secondary category matches even though the card only prints the primary one', () => {
  const tier = describeSearchResults(
    [app({ categories: ['development', 'finance'], primaryCategory: 'development' })],
    'finance',
  )[0]?.tier
  assert.equal(tier, 'category')
})

test('the description is the last thing that can explain a match before other', () => {
  const results = describeSearchResults(
    [
      app({ shortDescription: 'Track invoices and receipts.' }),
      app({ id: 'app-2', shortDescription: 'Nothing relevant here.' }),
    ],
    'invoices',
  )
  assert.deepEqual(
    results.map((result) => result.tier),
    ['description', 'other'],
  )
})

test('the provenance line explains a match the card does not print, and stays quiet when it does', () => {
  assert.equal(searchProvenance(app(), 'alias', 'pentest'), 'Also known as "pentest"')
  assert.equal(searchProvenance(app(), 'tag', 'scanner'), 'Matches "scanner" in tags')
  // A card highlighted nowhere reads as a wrong result rather than a lenient one.
  assert.equal(searchProvenance(app(), 'other', 'githb'), 'Close match for "githb"')
  for (const tier of ['name', 'category', 'description'] as const) {
    assert.equal(searchProvenance(app(), tier, 'git'), null, tier)
  }
})

test('a publisher match is explained only when the meta line is showing something else', () => {
  // The card prints "By Acme" only while there is no capability count to print
  // instead, so the hint is needed exactly when the count took the line.
  assert.equal(searchProvenance(app({ vendor: 'Acme' }), 'provider', 'acme'), null)
  assert.equal(
    searchProvenance(app({ toolCount: 4, vendor: 'Acme' }), 'provider', 'acme'),
    'Matches "acme" in the publisher name',
  )
})

test('the results label counts and quotes the trimmed query', () => {
  assert.equal(searchResultsLabel(1, ' git '), '1 result for "git"')
  assert.equal(searchResultsLabel(0, 'git'), '0 results for "git"')
  assert.equal(searchResultsLabel(12, 'git'), '12 results for "git"')
})

test('highlightSegments marks every occurrence, case-insensitively, in document order', () => {
  assert.deepEqual(highlightSegments('GitHub Enterprise', 'git'), [
    { match: true, text: 'Git' },
    { match: false, text: 'Hub Enterprise' },
  ])
  assert.deepEqual(highlightSegments('ab-AB-ab', 'ab'), [
    { match: true, text: 'ab' },
    { match: false, text: '-' },
    { match: true, text: 'AB' },
    { match: false, text: '-' },
    { match: true, text: 'ab' },
  ])
})

test('the query is matched literally, so a metacharacter cannot behave like a pattern', () => {
  // No regex is built from user input; "a.b" must not match "axb".
  assert.deepEqual(highlightSegments('a.b and axb', 'a.b'), [
    { match: true, text: 'a.b' },
    { match: false, text: ' and axb' },
  ])
})

test('a query too short to search, or absent from the text, leaves the string whole', () => {
  assert.deepEqual(highlightSegments('GitHub', 'g'), [{ match: false, text: 'GitHub' }])
  assert.deepEqual(highlightSegments('GitHub', 'zulip'), [{ match: false, text: 'GitHub' }])
  assert.deepEqual(highlightSegments('', 'git'), [{ match: false, text: '' }])
})
