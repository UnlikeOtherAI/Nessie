import assert from 'node:assert/strict'
import test from 'node:test'

import {
  githubIssueState,
  normaliseGitHubIssue,
  normaliseProjectItem,
  type GitHubIssue,
  type ProjectV2Item,
} from '../src/normalise.js'

const issue = (over: Partial<GitHubIssue> = {}): GitHubIssue => ({
  id: 1,
  node_id: 'I_node1',
  number: 17,
  html_url: 'https://github.com/acme/app/issues/17',
  title: 'Ship it',
  body: 'Detail',
  state: 'open',
  state_reason: null,
  assignee: { id: 99, login: 'alice' },
  labels: [{ id: 5, name: 'bug' }],
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-02T00:00:00.000Z',
  ...over,
})

// GitHub issues have two states and a reason, not a workflow — which is why an
// Issues board maps to three states and a person binds a label for more.
test('open, completed and not-planned are the three states', () => {
  assert.deepEqual(githubIssueState(issue()), { id: 'open', name: 'Open', category: 'todo' })
  assert.equal(
    githubIssueState(issue({ state: 'closed', state_reason: 'completed' })).category,
    'done',
  )
  assert.equal(
    githubIssueState(issue({ state: 'closed', state_reason: 'not_planned' })).category,
    'archived',
  )
  // A closed issue with no reason is completed, which is GitHub's own default.
  assert.equal(githubIssueState(issue({ state: 'closed', state_reason: null })).category, 'done')
})

test('an issue normalises, keeping its number as the key', () => {
  const item = normaliseGitHubIssue(issue())
  assert.equal(item.externalId, 'I_node1')
  assert.equal(item.externalKey, '#17')
  assert.deepEqual(item.labels, [{ id: '5', label: 'bug' }])
  assert.deepEqual(item.assignee, { externalUserId: '99', displayName: 'alice' })
  assert.equal(item.archived, false)
})

test('a not-planned issue is archived', () => {
  assert.equal(
    normaliseGitHubIssue(issue({ state: 'closed', state_reason: 'not_planned' })).archived,
    true,
  )
})

const projectItem = (over: Partial<ProjectV2Item> = {}): ProjectV2Item => ({
  id: 'PVTI_1',
  updatedAt: '2026-09-02T00:00:00.000Z',
  isArchived: false,
  content: {
    id: 'I_node1',
    number: 17,
    title: 'Ship it',
    body: 'Detail',
    url: 'https://github.com/acme/app/issues/17',
    createdAt: '2026-09-01T00:00:00.000Z',
    assignees: { nodes: [{ id: 'U_1', login: 'alice' }] },
  },
  fieldValues: {
    nodes: [
      { name: 'In Progress', optionId: 'opt-2', field: { name: 'Status' } },
      { number: 5, field: { name: 'Estimate' } },
    ],
  },
  ...over,
})

test("a project item's state is its Status option, and the rest are fields", () => {
  const item = normaliseProjectItem(projectItem())
  assert.ok(item)
  assert.equal(item.stateId, 'opt-2')
  assert.equal(item.stateName, 'In Progress')
  // Status is the state, so it is not also a field.
  assert.deepEqual(item.fields, { Estimate: 5 })
})

test('an item with no Status is reported as having none rather than guessed', () => {
  const item = normaliseProjectItem(projectItem({ fieldValues: { nodes: [] } }))
  assert.ok(item)
  assert.equal(item.stateId, 'no-status')
  assert.equal(item.stateName, 'No status')
})

// A redacted or unreachable content node has no URL to open and no identity to
// key on, so it is dropped rather than mirrored as a blank card.
test('an item with unreadable content is skipped', () => {
  assert.equal(normaliseProjectItem(projectItem({ content: null })), null)
})
