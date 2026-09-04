import assert from 'node:assert/strict'
import test from 'node:test'

import { trimPage } from '../src/pagination.js'

const rows = [
  { id: 'd', updatedAt: '2026-09-04T04:00:00.000Z' },
  { id: 'c', updatedAt: '2026-09-04T03:00:00.000Z' },
  { id: 'b', updatedAt: '2026-09-04T02:00:00.000Z' },
]

test('knowledge cursor pages preserve canonical order while fetching backwards', () => {
  // A backwards query arrives in ascending database order for the two rows
  // before the current page's first boundary.
  const page = trimPage([...rows].reverse(), 2, { direction: 'backward', hasCursor: true })

  assert.deepEqual(page.data.map((row) => row.id), ['c', 'b'])
  assert.equal(page.meta.cursor, `${rows[2]!.updatedAt}|${rows[2]!.id}`)
  assert.equal(page.meta.hasMore, true)
  assert.equal(page.meta.previousCursor, `${rows[1]!.updatedAt}|${rows[1]!.id}`)
})

test('knowledge forward cursor pages expose a fetchable previous boundary', () => {
  const page = trimPage(rows, 2, { direction: 'forward', hasCursor: true })

  assert.deepEqual(page.data.map((row) => row.id), ['d', 'c'])
  assert.equal(page.meta.cursor, `${rows[1]!.updatedAt}|${rows[1]!.id}`)
  assert.equal(page.meta.previousCursor, `${rows[0]!.updatedAt}|${rows[0]!.id}`)
})

test('knowledge cursor pages preserve a previous fallback after the boundary disappears', () => {
  const staleCursor = `${rows[1]!.updatedAt}|${rows[1]!.id}`
  const page = trimPage([], 2, {
    cursor: staleCursor,
    direction: 'forward',
    hasCursor: true,
  })

  assert.equal(page.meta.previousCursor, staleCursor)
})
