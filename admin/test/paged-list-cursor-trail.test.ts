import assert from 'node:assert/strict'
import test from 'node:test'

import {
  firstPageParams,
  pagedListParamNames,
  trailBackwardParams,
  trailForwardParams,
} from '../src/facades/pagination/cursor-trail.js'

/**
 * Paging back through a list the server pages forwards only (the DeepWater
 * research list): the cursors already walked through ride in the address, so
 * Previous, Back and a reload all land on the same page.
 */

const names = pagedListParamNames('')
const at = (search: string) => new URLSearchParams(search)
const walk = (params: URLSearchParams) => ({
  cursor: params.get('cursor'),
  page: params.get('page'),
  trail: params.getAll('trail'),
})

test('Next keeps the page it leaves in the trail; the first page has no cursor to keep', () => {
  const second = trailForwardParams(at('research=r1'), names, { cursor: 'c1', page: 1 })
  assert.deepEqual(walk(second), { cursor: 'c1', page: '1', trail: [] })
  assert.equal(second.get('research'), 'r1', 'other state on the address is left alone')
  const third = trailForwardParams(second, names, { cursor: 'c2', page: 2 })
  assert.deepEqual(walk(third), { cursor: 'c2', page: '2', trail: ['c1'] })
  const fourth = trailForwardParams(third, names, { cursor: 'c3', page: 3 })
  assert.deepEqual(walk(fourth), { cursor: 'c3', page: '3', trail: ['c1', 'c2'] })
})

test('Previous walks back along the trail to the first page', () => {
  const fourth = at('cursor=c3&page=3&trail=c1&trail=c2')
  const third = trailBackwardParams(fourth, names, 3)
  assert.deepEqual(walk(third), { cursor: 'c2', page: '2', trail: ['c1'] })
  const second = trailBackwardParams(third, names, 2)
  assert.deepEqual(walk(second), { cursor: 'c1', page: '1', trail: [] })
  const first = trailBackwardParams(second, names, 1)
  assert.deepEqual(walk(first), { cursor: null, page: null, trail: [] })
})

test('an address whose trail does not match its page goes back to the first page', () => {
  // Cut short (a hand-edited or shared address): no page it cannot name.
  assert.deepEqual(walk(trailBackwardParams(at('cursor=c3&page=3&trail=c2'), names, 3)), {
    cursor: null, page: null, trail: [],
  })
})

test('a keyset cursor survives the address unchanged', () => {
  const cursor = '2026-09-23T09:40:00.000Z|50000000-0000-4000-8000-000000000003'
  const second = trailForwardParams(at(''), names, { cursor, page: 1 })
  const third = trailForwardParams(at(second.toString()), names, { cursor: 'next', page: 2 })
  assert.deepEqual(at(third.toString()).getAll('trail'), [cursor])
  assert.equal(trailBackwardParams(at(third.toString()), names, 2).get('cursor'), cursor)
})

test('a prefixed list keeps its own trail, and the first page clears all of it', () => {
  const prefixed = pagedListParamNames('runs_')
  const params = trailForwardParams(at('runs_cursor=c1&runs_page=1&cursor=other'), prefixed, {
    cursor: 'c2', page: 2, scope: 'team-1',
  })
  assert.deepEqual(params.getAll('runs_trail'), ['c1'])
  assert.equal(params.get('runs_scope'), 'team-1')
  assert.equal(params.get('cursor'), 'other', 'another list on the page is untouched')
  const reset = firstPageParams(params, prefixed)
  for (const key of ['runs_cursor', 'runs_page', 'runs_trail', 'runs_direction']) assert.equal(reset.get(key), null)
  assert.equal(reset.get('cursor'), 'other')
})
