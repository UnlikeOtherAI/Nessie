import assert from 'node:assert/strict'
import test from 'node:test'

import {
  __resetAgentBrowserState,
  loadAgentBrowserState,
  saveAgentBrowserState,
} from '../src/components/features/agents/agent-browser-state.js'

test('the default browser state is an empty selection at column 0', () => {
  __resetAgentBrowserState()
  assert.deepEqual(loadAgentBrowserState(), { selectionPath: [], activeColumn: 0 })
})

test('a saved selection survives to the next load (across an unmount)', () => {
  __resetAgentBrowserState()
  saveAgentBrowserState({ selectionPath: ['a', 'b'], activeColumn: 2 })
  assert.deepEqual(loadAgentBrowserState(), {
    selectionPath: ['a', 'b'],
    activeColumn: 2,
  })
})

test('loaded state is a copy — mutating it does not corrupt the store', () => {
  __resetAgentBrowserState()
  saveAgentBrowserState({ selectionPath: ['a'], activeColumn: 1 })
  const loaded = loadAgentBrowserState()
  loaded.selectionPath.push('mutated')
  assert.deepEqual(loadAgentBrowserState().selectionPath, ['a'])
})

test('saving is snapshot-by-value, not by reference', () => {
  __resetAgentBrowserState()
  const path = ['a']
  saveAgentBrowserState({ selectionPath: path, activeColumn: 1 })
  path.push('b')
  assert.deepEqual(loadAgentBrowserState().selectionPath, ['a'])
})
