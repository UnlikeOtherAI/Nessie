import assert from 'node:assert/strict'
import test from 'node:test'

import { partitionPageHeaderActions } from '../src/components/shared/responsive-page-header-layout.js'

const actions = [
  { id: 'view', priority: 70, width: 104 },
  { id: 'review', priority: 60, width: 116 },
  { id: 'upload', priority: 40, width: 92 },
  { id: 'settings', priority: 10, width: 30 },
  { id: 'new-page', primary: true, priority: 100, width: 82 },
]

test('page header keeps its primary action and moves low-priority actions to More', () => {
  assert.deepEqual(partitionPageHeaderActions(actions, 400, 34), {
    visibleIds: ['view', 'review', 'new-page'],
    overflowIds: ['upload', 'settings'],
  })
})

test('page header does not add an overflow trigger when all actions fit', () => {
  assert.deepEqual(partitionPageHeaderActions(actions, 500, 34), {
    visibleIds: ['view', 'review', 'upload', 'settings', 'new-page'],
    overflowIds: [],
  })
})

test('a pinned action never collapses into More, however narrow the header', () => {
  // The board's assignee filter: it carries the state the board is read
  // through, and More renders menu rows, which it has none of. `primary` is
  // already exempt for the opposite reason — it is the screen's main verb.
  const withPinned = [
    { id: 'assignee', pinned: true, priority: 20, width: 180 },
    { id: 'configure', priority: 60, width: 96 },
    { id: 'new-task', primary: true, priority: 100, width: 82 },
  ]

  assert.deepEqual(partitionPageHeaderActions(withPinned, 120, 34), {
    visibleIds: ['assignee', 'new-task'],
    overflowIds: ['configure'],
  })
})

test('a pinned action is not a reason to keep anything else', () => {
  // It is exempt, not privileged: everything around it still overflows by
  // priority, lowest first.
  const actions = [
    { id: 'assignee', pinned: true, priority: 20, width: 180 },
    { id: 'filter', priority: 30, width: 90 },
    { id: 'configure', priority: 60, width: 96 },
  ]

  // 180 + 96 + the 34 More trigger + two 8px gaps = 326.
  assert.deepEqual(partitionPageHeaderActions(actions, 326, 34), {
    visibleIds: ['assignee', 'configure'],
    overflowIds: ['filter'],
  })
})
