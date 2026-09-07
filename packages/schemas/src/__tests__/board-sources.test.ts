import assert from 'node:assert/strict'
import test from 'node:test'

import { PutBoardSourceMappingsBodySchema } from '../board-sources.js'

const state = (
  externalStateId: string,
  category: 'todo' | 'in_progress' | 'review' | 'done' | 'archived' | null,
  isDefaultForCategory: boolean,
) => ({ externalStateId, externalStateName: externalStateId, category, isDefaultForCategory })

const mappingBody = (stateMapping: ReturnType<typeof state>[]) => ({
  stateMapping,
  fieldMappings: [],
  identityLinks: [],
})

test('state mappings allow one default for each active board category', () => {
  assert.equal(PutBoardSourceMappingsBodySchema.safeParse(mappingBody([
    state('todo', 'todo', true),
    state('progress', 'in_progress', true),
    state('review', 'review', true),
    state('done', 'done', true),
    state('cancelled', 'archived', false),
    state('unknown', null, false),
  ])).success, true)
})

test('state mappings reject two default write-back states for one category', () => {
  assert.equal(PutBoardSourceMappingsBodySchema.safeParse(mappingBody([
    state('todo-a', 'todo', true),
    state('todo-b', 'todo', true),
  ])).success, false)
})

test('state mappings reject defaults for archived and unmapped states', () => {
  assert.equal(PutBoardSourceMappingsBodySchema.safeParse(mappingBody([
    state('cancelled', 'archived', true),
  ])).success, false)
  assert.equal(PutBoardSourceMappingsBodySchema.safeParse(mappingBody([
    state('unknown', null, true),
  ])).success, false)
})
