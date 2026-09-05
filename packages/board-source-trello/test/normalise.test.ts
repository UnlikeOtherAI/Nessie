import assert from 'node:assert/strict'
import test from 'node:test'

import { normaliseTrelloCard, trelloListCategory, type TrelloCard } from '../src/normalise.js'

const card = (over: Partial<TrelloCard> = {}): TrelloCard => ({
  id: 'card-1',
  idShort: 7,
  name: 'Ship it',
  desc: 'Detail',
  url: 'https://trello.com/c/abc/7-ship-it',
  closed: false,
  idList: 'list-2',
  idMembers: ['member-1'],
  labels: [{ id: 'label-1', name: 'bug' }],
  due: '2026-09-30T12:00:00.000Z',
  dateLastActivity: '2026-09-02T00:00:00.000Z',
  ...over,
})

// Order is the only signal a Trello board gives about what a list means.
test('list order gives the default category', () => {
  assert.equal(trelloListCategory(0, 4), 'todo')
  assert.equal(trelloListCategory(1, 4), 'in_progress')
  assert.equal(trelloListCategory(2, 4), 'in_progress')
  assert.equal(trelloListCategory(3, 4), 'done')
  // A one-list board is where work starts, not where it ends.
  assert.equal(trelloListCategory(0, 1), 'todo')
})

test('a card normalises with its list as the state', () => {
  const item = normaliseTrelloCard(card(), new Map([['list-2', 'Doing']]))
  assert.equal(item.externalKey, '#7')
  assert.equal(item.stateId, 'list-2')
  assert.equal(item.stateName, 'Doing')
  assert.equal(item.dueDate, '2026-09-30')
  assert.deepEqual(item.labels, [{ id: 'label-1', label: 'bug' }])
  assert.equal(item.archived, false)
})

test('a closed card has left the board', () => {
  assert.equal(normaliseTrelloCard(card({ closed: true }), new Map()).archived, true)
})

// Trello cards carry many members; a board shows one assignee.
test('the first member is the assignee and the rest are left alone', () => {
  const item = normaliseTrelloCard(card({ idMembers: ['a', 'b', 'c'] }), new Map())
  assert.equal(item.assignee?.externalUserId, 'a')
  assert.equal(normaliseTrelloCard(card({ idMembers: [] }), new Map()).assignee, null)
})
