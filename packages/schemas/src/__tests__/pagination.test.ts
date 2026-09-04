import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, PaginationMetaSchema } from '../api.js'
import {
  buildPage,
  buildPageLabel,
  decodeKeysetCursor,
  encodeKeysetCursor,
  resolvePageLimit,
  resolvePageSize,
} from '../pagination.js'

const row = (iso: string, id: string) => ({ createdAt: new Date(iso), id })

const page = [
  row('2026-09-01T10:00:00.000Z', 'a'),
  row('2026-09-01T09:00:00.000Z', 'b'),
  row('2026-09-01T08:00:00.000Z', 'c'),
]

test('a cursor round-trips and rejects anything malformed', () => {
  const cursor = encodeKeysetCursor(row('2026-09-01T10:00:00.000Z', 'abc'))
  const decoded = decodeKeysetCursor(cursor)

  assert.equal(decoded?.id, 'abc')
  assert.equal(decoded?.createdAt.toISOString(), '2026-09-01T10:00:00.000Z')

  // An id may contain anything, including the separator, so only the first one
  // splits — a cursor is opaque and must survive whatever the id holds.
  assert.equal(decodeKeysetCursor('2026-09-01T10:00:00.000Z|a|b')?.id, 'a|b')

  for (const bad of [undefined, '', 'no-separator', '|missing-date', 'not-a-date|x']) {
    assert.equal(decodeKeysetCursor(bad), null, `expected ${String(bad)} to be rejected`)
  }
})

test('the over-fetched row is dropped and becomes hasMore', () => {
  const result = buildPage({ hasCursor: false, limit: 2, rows: page, total: 9 })

  assert.equal(result.data.length, 2)
  assert.equal(result.meta.hasMore, true)
  assert.equal(result.meta.total, 9)
  // Points at the last row of THIS page, so the next page starts after it.
  assert.equal(result.meta.nextCursor, encodeKeysetCursor(page[1]!))
})

test('the first page has no previous cursor and a short page has no next', () => {
  const first = buildPage({ hasCursor: false, limit: 10, rows: page })

  assert.equal(first.meta.prevCursor, null, 'nothing precedes the first page')
  assert.equal(first.meta.nextCursor, null, 'a page shorter than the limit is the last one')
  assert.equal(first.meta.hasMore, false)
  assert.equal(first.data.length, 3)

  const second = buildPage({ hasCursor: true, limit: 10, rows: page })
  assert.equal(second.meta.prevCursor, encodeKeysetCursor(page[0]!))
})

test('an empty result yields no cursors in either direction', () => {
  const result = buildPage({ hasCursor: true, limit: 10, rows: [], total: 0 })

  assert.deepEqual(result.meta, { hasMore: false, nextCursor: null, prevCursor: null, total: 0 })
})

test('the meta it builds is exactly what the wire schema accepts', () => {
  for (const input of [
    { hasCursor: false, limit: 2, rows: page, total: 9 },
    { hasCursor: true, limit: 10, rows: page },
    { hasCursor: false, limit: 5, rows: [] },
  ]) {
    assert.doesNotThrow(() => PaginationMetaSchema.parse(buildPage(input).meta))
  }
})

test('the page limit is clamped to the one size the admin uses', () => {
  assert.equal(resolvePageLimit(undefined), DEFAULT_PAGE_LIMIT)
  assert.equal(resolvePageLimit(0), DEFAULT_PAGE_LIMIT)
  assert.equal(resolvePageLimit(Number.NaN), DEFAULT_PAGE_LIMIT)
  assert.equal(resolvePageLimit(10), 10)
  assert.equal(resolvePageLimit(10.7), 10)
  assert.equal(resolvePageLimit(5_000), MAX_PAGE_LIMIT)
  assert.equal(resolvePageLimit(-4), 1)
})

test('the page size accepts only the shared picker options', () => {
  assert.equal(resolvePageSize(10), 10)
  assert.equal(resolvePageSize(50), 50)
  assert.equal(resolvePageSize(42), DEFAULT_PAGE_LIMIT)
  assert.equal(resolvePageSize(undefined), DEFAULT_PAGE_LIMIT)
})

test('a backward query restores canonical order and leaves both neighbours usable', () => {
  // A descending list's preceding page is read in ascending order. The
  // over-fetched final row belongs to the page before it.
  const backwardRows = [
    row('2026-09-01T08:00:00.000Z', 'c'),
    row('2026-09-01T09:00:00.000Z', 'b'),
    row('2026-09-01T10:00:00.000Z', 'a'),
  ]
  const result = buildPage({ direction: 'backward', hasCursor: true, limit: 2, rows: backwardRows, total: 4 })

  assert.deepEqual(result.data.map((entry) => entry.id), ['b', 'c'])
  assert.equal(result.meta.prevCursor, encodeKeysetCursor(row('2026-09-01T09:00:00.000Z', 'b')))
  assert.equal(result.meta.nextCursor, encodeKeysetCursor(row('2026-09-01T08:00:00.000Z', 'c')))
  assert.equal(result.meta.hasMore, true)
})

test('the label states a range, and a total only when the server sent one', () => {
  assert.equal(buildPageLabel({ total: 134 }, 25, 25), '26–50 of 134')
  assert.equal(buildPageLabel({}, 25, 25), '26–50')
  assert.equal(buildPageLabel({ total: 0 }, 0, 0), '0 of 0')
  assert.equal(buildPageLabel({}, 0, 0), 'No results')
})
