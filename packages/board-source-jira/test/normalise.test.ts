import assert from 'node:assert/strict'
import test from 'node:test'

import { adfToText, jiraStatusCategory, normaliseJiraIssue, type JiraIssue } from '../src/normalise.js'

const issue = (over: Partial<JiraIssue['fields']> = {}): JiraIssue => ({
  id: '10001',
  key: 'PROJ-42',
  fields: {
    summary: 'Ship it',
    description: { type: 'doc', content: [{ type: 'paragraph', content: [{ text: 'Detail' }] }] },
    status: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    assignee: { accountId: 'acct-1', displayName: 'Alice', emailAddress: 'alice@example.test' },
    priority: { id: '2', name: 'High' },
    duedate: '2026-09-30',
    labels: ['bug'],
    created: '2026-09-01T00:00:00.000Z',
    updated: '2026-09-02T00:00:00.000Z',
    issuetype: { name: 'Task' },
    ...over,
  },
})

// Jira's own classification of its own workflow is the only honest basis for a
// default; a status *name* is not evidence of what it means.
test('statusCategory decides the category, and nothing maps to review', () => {
  assert.equal(jiraStatusCategory('new'), 'todo')
  assert.equal(jiraStatusCategory('indeterminate'), 'in_progress')
  assert.equal(jiraStatusCategory('done'), 'done')
  assert.equal(jiraStatusCategory(undefined), null)
  assert.equal(jiraStatusCategory('something-else'), null)
})

test('an Atlassian document collapses to its text', () => {
  assert.equal(
    adfToText({ type: 'doc', content: [{ type: 'paragraph', content: [{ text: 'Hello' }] }] }),
    'Hello',
  )
  assert.equal(adfToText('already text'), 'already text')
  assert.equal(adfToText(null), null)
  assert.equal(adfToText({ type: 'doc', content: [] }), null)
})

test('an issue normalises, and its URL points at the site it lives on', () => {
  const item = normaliseJiraIssue(issue(), 'https://acme.atlassian.net/')
  assert.equal(item.externalKey, 'PROJ-42')
  assert.equal(item.url, 'https://acme.atlassian.net/browse/PROJ-42')
  assert.equal(item.description, 'Detail')
  assert.equal(item.priority, 'high')
  assert.equal(item.dueDate, '2026-09-30')
  assert.deepEqual(item.assignee, {
    externalUserId: 'acct-1',
    displayName: 'Alice',
    email: 'alice@example.test',
  })
})

test("Jira's five priorities map onto the four Nessie has", () => {
  for (const [name, expected] of [
    ['Highest', 'urgent'],
    ['High', 'high'],
    ['Medium', 'medium'],
    ['Low', 'low'],
    ['Lowest', 'low'],
  ] as const) {
    assert.equal(normaliseJiraIssue(issue({ priority: { id: '1', name } }), '').priority, expected)
  }
  assert.equal(normaliseJiraIssue(issue({ priority: null }), '').priority, null)
})

// An account that hides its address is the norm, not a failure.
test('an assignee with no visible email still normalises', () => {
  const item = normaliseJiraIssue(
    issue({ assignee: { accountId: 'acct-2', displayName: 'Bob' } }),
    '',
  )
  assert.deepEqual(item.assignee, { externalUserId: 'acct-2', displayName: 'Bob' })
})
