import assert from 'node:assert/strict'
import test from 'node:test'

import { type NormalisedItem, itemFingerprint } from '../src/items.js'

const item = (over: Partial<NormalisedItem> = {}): NormalisedItem => ({
  externalId: 'issue-1',
  externalKey: 'ENG-1',
  url: 'https://linear.app/x/issue/ENG-1',
  title: 'Ship the thing',
  description: 'Some detail',
  stateId: 'state-todo',
  stateName: 'Todo',
  assignee: { externalUserId: 'user-1', displayName: 'Alice' },
  priority: 'high',
  dueDate: '2026-09-30',
  labels: [{ id: 'label-1', label: 'bug' }],
  fields: { estimate: 3, labels: ['label-1'] },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  archived: false,
  ...over,
})

test('the same item hashes the same however the labels are ordered', () => {
  const a = item({ labels: [{ id: 'x', label: 'x' }, { id: 'y', label: 'y' }] })
  const b = item({ labels: [{ id: 'y', label: 'y' }, { id: 'x', label: 'x' }] })
  assert.equal(itemFingerprint(a, []), itemFingerprint(b, []))
})

test('a change to a mapped field changes the fingerprint', () => {
  const before = itemFingerprint(item(), ['estimate'])
  const after = itemFingerprint(item({ fields: { estimate: 5, labels: ['label-1'] } }), [
    'estimate',
  ])
  assert.notEqual(before, after)
})

// This is what makes echo suppression exact rather than heuristic: a change to
// something this source does not map is not a change the board can see, so it
// must not look like one.
test('a change to an unmapped field does not', () => {
  const before = itemFingerprint(item(), ['labels'])
  const after = itemFingerprint(item({ fields: { estimate: 99, labels: ['label-1'] } }), [
    'labels',
  ])
  assert.equal(before, after)
})

test('the fields a fingerprint covers do not depend on the order they are listed', () => {
  assert.equal(
    itemFingerprint(item(), ['estimate', 'labels']),
    itemFingerprint(item(), ['labels', 'estimate']),
  )
})

test('every field the board renders is covered', () => {
  const base = itemFingerprint(item(), [])
  for (const change of [
    { title: 'Different' },
    { description: 'Different' },
    { stateId: 'state-done' },
    { assignee: null },
    { priority: 'low' },
    { dueDate: '2026-10-01' },
    { archived: true },
  ] as Partial<NormalisedItem>[]) {
    assert.notEqual(itemFingerprint(item(change), []), base, JSON.stringify(change))
  }
})

// `updatedAt` moves on every touch upstream, including the ones the vendor
// makes applying our own write. Hashing it would defeat the whole mechanism.
test('a bare timestamp bump is not a change', () => {
  assert.equal(
    itemFingerprint(item(), []),
    itemFingerprint(item({ updatedAt: '2026-09-09T00:00:00.000Z' }), []),
  )
})
