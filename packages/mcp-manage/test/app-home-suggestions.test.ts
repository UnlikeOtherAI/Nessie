import assert from 'node:assert/strict'
import test from 'node:test'

import { APP_CATEGORIES } from '@nessie/schemas'

import {
  APP_HOME_SUGGESTIONS,
  appHomeSuggestionRegistryNames,
  prioritizeHomeShelf,
} from '../src/apps/app-home-suggestions.js'

type ShelfRow = {
  id: string
  primaryCategory: 'communication' | 'development'
  registryName: string | null
}

const row = (
  id: string,
  primaryCategory: ShelfRow['primaryCategory'],
  registryName: string | null,
): ShelfRow => ({ id, primaryCategory, registryName })

test('promotes configured visible suggestions in editorial order before the normal shelf', () => {
  const normalShelf = [
    row('alphabetical-first', 'communication', 'com.example/a'),
    row('teams', 'communication', 'com.microsoft/workiq-teamsserver'),
    row('zoom', 'communication', 'io.github.zoom/zoom-team-chat'),
  ]
  const results = prioritizeHomeShelf('communication', normalShelf, normalShelf, 12)

  assert.deepEqual(results.map((item) => item.id), ['teams', 'zoom', 'alphabetical-first'])
})

test('can promote a visible suggestion that would be outside the bounded alphabetical shelf', () => {
  const results = prioritizeHomeShelf(
    'communication',
    [row('teams', 'communication', 'com.microsoft/workiq-teamsserver')],
    [row('alphabetical-first', 'communication', 'com.example/a')],
    2,
  )

  assert.deepEqual(results.map((item) => item.id), ['teams', 'alphabetical-first'])
})

test('does not move an app into a category the catalogue has not assigned it to', () => {
  const results = prioritizeHomeShelf(
    'communication',
    [row('misclassified', 'development', 'com.microsoft/workiq-teamsserver')],
    [row('normal', 'communication', 'com.example/a')],
    12,
  )

  assert.deepEqual(results.map((item) => item.id), ['normal'])
})

test('collects unique registry identities for the bounded suggestions query', () => {
  const names = appHomeSuggestionRegistryNames()

  assert.equal(names.filter((name) => name === 'app.linear/linear').length, 1)
  assert.ok(names.includes('com.microsoft/workiq-teamsserver'))
})

test('has an editorial suggestion for every App Store category', () => {
  for (const category of APP_CATEGORIES) {
    assert.ok(APP_HOME_SUGGESTIONS[category].length > 0, category)
  }
})
