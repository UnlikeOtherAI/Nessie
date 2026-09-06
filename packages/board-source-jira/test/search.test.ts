import assert from 'node:assert/strict'
import test from 'node:test'

import { jiraSearchJql } from '../src/search.js'

/**
 * Read the JQL the way Jira does: walk it, and return the contents of each
 * complete string literal. Counting quotes with a regex cannot do this — a
 * correctly escaped backslash legitimately sits before the closing quote —
 * and the property worth asserting is that the text stayed *inside* one
 * literal rather than becoming query structure.
 */
const stringLiterals = (jql: string): string[] => {
  const literals: string[] = []
  let inside = false
  let current = ''
  for (let index = 0; index < jql.length; index += 1) {
    const char = jql[index]
    if (inside && char === '\\') {
      current += jql[index + 1] ?? ''
      index += 1
      continue
    }
    if (char === '"') {
      if (inside) literals.push(current)
      inside = !inside
      current = ''
      continue
    }
    if (inside) current += char
  }
  assert.equal(inside, false, 'the JQL ended inside an unterminated string')
  return literals
}

test('a plain search is scoped to the project the source attached', () => {
  assert.equal(
    jiraSearchJql('ENG', 'broken exporter'),
    'project = "ENG" AND text ~ "broken exporter" ORDER BY updated DESC',
  )
})

// The text is a person's words inside a query language. Unescaped, this term
// would close the string and append a clause of its own — and the credential
// asking would read a project this source was never pointed at.
test('a quote in the search text stays text instead of becoming a clause', () => {
  const jql = jiraSearchJql('ENG', '" OR project = "SECRET')
  assert.deepEqual(stringLiterals(jql), ['ENG', '" OR project = "SECRET'])
  assert.equal(jql.includes('OR project'), true)
  // …but only inside the literal: no second project clause was created.
  assert.equal(/AND text ~ "(?:[^"\\]|\\.)*"\s+ORDER BY updated DESC$/.test(jql), true)
})

test('a trailing backslash cannot escape the closing quote', () => {
  const jql = jiraSearchJql('ENG', 'path\\')
  assert.deepEqual(stringLiterals(jql), ['ENG', 'path\\'])
})

test('the project key is quoted the same way', () => {
  assert.deepEqual(stringLiterals(jiraSearchJql('A"B', 'x')), ['A"B', 'x'])
})
