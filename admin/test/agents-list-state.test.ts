import assert from 'node:assert/strict'
import test from 'node:test'

import {
  __resetAgentsListState,
  loadAgentsListState,
  saveAgentsListState,
} from '../src/components/features/agents/agents-list-state.js'

test('the default list state opens the Team tab at the first page of every tab', () => {
  __resetAgentsListState()
  assert.deepEqual(loadAgentsListState(), {
    activeScope: 'team',
    pageByScope: { global: 0, personal: 0, team: 0 },
    pageSize: 25,
  })
})

test('a saved tab and page survive to the next load (across an unmount)', () => {
  __resetAgentsListState()
  saveAgentsListState({
    activeScope: 'global',
    pageByScope: { global: 2, personal: 0, team: 1 },
    pageSize: 50,
  })
  assert.deepEqual(loadAgentsListState(), {
    activeScope: 'global',
    pageByScope: { global: 2, personal: 0, team: 1 },
    pageSize: 50,
  })
})

test('loaded state is a copy — mutating it does not corrupt the store', () => {
  __resetAgentsListState()
  saveAgentsListState({
    activeScope: 'team',
    pageByScope: { global: 0, personal: 0, team: 3 },
    pageSize: 25,
  })
  const loaded = loadAgentsListState()
  loaded.pageByScope.team = 99
  assert.equal(loadAgentsListState().pageByScope.team, 3)
})

test('saving is snapshot-by-value, not by reference', () => {
  __resetAgentsListState()
  const pageByScope = { global: 0, personal: 0, team: 1 } as const
  saveAgentsListState({ activeScope: 'team', pageByScope: { ...pageByScope }, pageSize: 25 })
  const mutable = { global: 0, personal: 0, team: 1 }
  saveAgentsListState({ activeScope: 'team', pageByScope: mutable, pageSize: 25 })
  mutable.team = 7
  assert.equal(loadAgentsListState().pageByScope.team, 1)
})
