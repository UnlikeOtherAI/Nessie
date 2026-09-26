import assert from 'node:assert/strict'
import test from 'node:test'

import {
  __resetAgentsListState,
  loadAgentsListState,
  saveAgentsListState,
} from '../src/components/features/agents/agents-list-state.js'
import { AGENT_LIST_TABS, agentListTab } from '../src/components/features/agents/agents-list-tabs.js'
import type { AgentRecord } from '../src/lib/api-client'

test('the default list state opens the Shared tab at the first page of every tab', () => {
  __resetAgentsListState()
  assert.deepEqual(loadAgentsListState(), {
    activeTab: 'shared',
    pageByTab: { 'built-in': 0, mine: 0, shared: 0 },
    pageSize: 25,
  })
})

test('a saved tab and page survive to the next load (across an unmount)', () => {
  __resetAgentsListState()
  saveAgentsListState({
    activeTab: 'built-in',
    pageByTab: { 'built-in': 2, mine: 0, shared: 1 },
    pageSize: 50,
  })
  assert.deepEqual(loadAgentsListState(), {
    activeTab: 'built-in',
    pageByTab: { 'built-in': 2, mine: 0, shared: 1 },
    pageSize: 50,
  })
})

test('loaded state is a copy — mutating it does not corrupt the store', () => {
  __resetAgentsListState()
  saveAgentsListState({
    activeTab: 'shared',
    pageByTab: { 'built-in': 0, mine: 0, shared: 3 },
    pageSize: 25,
  })
  const loaded = loadAgentsListState()
  loaded.pageByTab.shared = 99
  assert.equal(loadAgentsListState().pageByTab.shared, 3)
})

test('saving is snapshot-by-value, not by reference', () => {
  __resetAgentsListState()
  const mutable = { 'built-in': 0, mine: 0, shared: 1 }
  saveAgentsListState({ activeTab: 'shared', pageByTab: mutable, pageSize: 25 })
  mutable.shared = 7
  assert.equal(loadAgentsListState().pageByTab.shared, 1)
})

const agent = (overrides: Partial<AgentRecord>): AgentRecord =>
  ({ agentKind: 'shared', systemManaged: false, visibility: 'team', ...overrides }) as AgentRecord

test('the three tabs are Mine, Shared and Built-in, in that order', () => {
  assert.deepEqual([...AGENT_LIST_TABS], ['mine', 'shared', 'built-in'])
})

test('an agent lands on the tab its kind says, the Personal Assistant on Mine', () => {
  assert.equal(agentListTab(agent({})), 'shared')
  assert.equal(agentListTab(agent({ visibility: 'private' })), 'mine')
  assert.equal(agentListTab(agent({ systemManaged: true })), 'built-in')
  // The Personal Assistant is system-managed too, and still the reader's own.
  assert.equal(agentListTab(agent({ agentKind: 'personal_assistant', systemManaged: true })), 'mine')
})
