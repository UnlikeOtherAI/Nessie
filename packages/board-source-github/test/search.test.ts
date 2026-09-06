import assert from 'node:assert/strict'
import test from 'node:test'

import { gitHubSearchQuery } from '../src/search.js'

test('a search is scoped to the repository the source attached', () => {
  assert.equal(
    gitHubSearchQuery('acme', 'api', 'broken exporter'),
    'repo:acme/api is:issue "broken exporter"',
  )
})

// GitHub's grammar is space-separated qualifiers, so a quote that survived
// into the query could close the phrase and let the rest be read as
// qualifiers — including a second `repo:` this project never connected.
test('a quote in the text cannot escape the phrase and add a qualifier', () => {
  const query = gitHubSearchQuery('acme', 'api', '" repo:other/private')
  assert.equal(query, 'repo:acme/api is:issue "repo:other/private"')
  assert.equal(query.match(/"/g)?.length, 2)
})

test('the repository qualifier stays first, whatever the text says', () => {
  assert.match(gitHubSearchQuery('acme', 'api', 'repo:other/private'), /^repo:acme\/api /)
})
