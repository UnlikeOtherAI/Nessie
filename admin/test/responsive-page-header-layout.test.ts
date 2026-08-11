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
