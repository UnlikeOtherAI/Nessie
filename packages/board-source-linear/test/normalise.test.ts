import assert from 'node:assert/strict'
import test from 'node:test'

import { LINEAR_PRIORITY_TOKENS, linearStateCategory, normaliseLinearIssue } from '../src/normalise.js'
import type { LinearIssue } from '../src/normalise.js'

const issue = (over: Partial<LinearIssue> = {}): LinearIssue => ({
  id: 'issue-1',
  identifier: 'ENG-42',
  url: 'https://linear.app/acme/issue/ENG-42',
  title: 'Ship it',
  description: 'Detail',
  priority: 2,
  estimate: 3,
  dueDate: '2026-09-30',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  archivedAt: null,
  state: { id: 'state-1', name: 'In Progress', type: 'started' },
  assignee: { id: 'user-1', name: 'Alice', email: 'alice@example.test' },
  labels: { nodes: [{ id: 'label-1', name: 'bug' }] },
  ...over,
})

test('state type decides the category, and nothing maps to review', () => {
  assert.equal(linearStateCategory('backlog'), 'todo')
  assert.equal(linearStateCategory('unstarted'), 'todo')
  assert.equal(linearStateCategory('triage'), 'todo')
  assert.equal(linearStateCategory('started'), 'in_progress')
  assert.equal(linearStateCategory('completed'), 'done')
  assert.equal(linearStateCategory('canceled'), 'archived')
  assert.equal(linearStateCategory('something-new'), null)

  // A state's *name* is not evidence of its meaning: a workspace calling a
  // started state "In Review" still lands in `in_progress` until a person
  // promotes it. Guessing from names is exactly what the design forbids.
  assert.equal(linearStateCategory('started'), 'in_progress')
})

test('an issue normalises into the provider-agnostic shape', () => {
  const item = normaliseLinearIssue(issue())
  assert.equal(item.externalId, 'issue-1')
  assert.equal(item.externalKey, 'ENG-42')
  assert.equal(item.stateId, 'state-1')
  assert.equal(item.priority, 'high')
  assert.equal(item.dueDate, '2026-09-30')
  assert.deepEqual(item.assignee, {
    externalUserId: 'user-1',
    displayName: 'Alice',
    email: 'alice@example.test',
  })
  assert.deepEqual(item.labels, [{ id: 'label-1', label: 'bug' }])
  assert.deepEqual(item.fields, { estimate: 3, labels: ['label-1'] })
  assert.equal(item.archived, false)
})

test('priority 0 is "no priority", not the lowest one', () => {
  assert.equal(LINEAR_PRIORITY_TOKENS[0], 'none')
  assert.equal(normaliseLinearIssue(issue({ priority: 0 })).priority, 'none')
  assert.equal(normaliseLinearIssue(issue({ priority: 4 })).priority, 'low')
  assert.equal(normaliseLinearIssue(issue({ priority: null })).priority, null)
})

test('a cancelled or archived issue is archived either way', () => {
  assert.equal(
    normaliseLinearIssue(issue({ state: { id: 's', name: 'Cancelled', type: 'canceled' } }))
      .archived,
    true,
  )
  assert.equal(normaliseLinearIssue(issue({ archivedAt: '2026-09-03T00:00:00.000Z' })).archived, true)
})

test('an unassigned issue with no due date carries nulls, not empty strings', () => {
  const item = normaliseLinearIssue(issue({ assignee: null, dueDate: null, labels: null }))
  assert.equal(item.assignee, null)
  assert.equal(item.dueDate, null)
  assert.deepEqual(item.labels, [])
})

// Every state type a real Linear workspace was observed to use. `duplicate` is
// the one the documented list omits: Linear creates a Duplicate state in every
// team it makes, so a workspace where no team has one is the exception, not the
// rule. Leaving it unmapped meant every real team connected with an unmapped
// state and turned the source `misconfigured` on its first sync.
test('every state type Linear actually issues has a category', () => {
  for (const type of [
    'triage',
    'backlog',
    'unstarted',
    'started',
    'completed',
    'canceled',
    'duplicate',
  ]) {
    assert.notEqual(
      linearStateCategory(type),
      null,
      `${type} has no category, so a team using it would not map`,
    )
  }
})

test('a duplicate leaves the board the way a cancellation does', () => {
  assert.equal(linearStateCategory('duplicate'), 'archived')
  assert.equal(linearStateCategory('canceled'), 'archived')
})

// A type nobody has seen still returns null rather than being guessed at: an
// unmapped state is a question for a person, and `null` is how it gets asked.
test('an unknown state type is left for a person to map', () => {
  assert.equal(linearStateCategory('something_new'), null)
})
