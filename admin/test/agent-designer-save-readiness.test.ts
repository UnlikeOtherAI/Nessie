import assert from 'node:assert/strict'
import test from 'node:test'

import { saveBlockedReason } from '../src/components/features/agents/designer/save-readiness.js'
import {
  buildToolPolicy,
  completeToolSelection,
  type DesignerToolOption,
} from '../src/facades/designer/tool-catalog.js'

const ordinaryTools: DesignerToolOption[] = [
  {
    allowMode: false,
    defaultEnabled: true,
    description: 'Search public information.',
    group: 'Research',
    key: 'web_search',
    kind: 'builtin',
    label: 'Web search',
  },
  {
    allowMode: true,
    defaultEnabled: false,
    description: 'Create a ticket.',
    group: 'Connectors (MCP)',
    key: 'connector-ticket',
    kind: 'mcp',
    label: 'Ticket create',
  },
]

test('a complete form blocks nothing', () => {
  assert.equal(
    saveBlockedReason({ action: 'create', hasModel: true, hasName: true }),
    null,
  )
  assert.equal(
    saveBlockedReason({ action: 'save', hasModel: true, hasName: true }),
    null,
  )
})

test('each missing field is named, and both are named together', () => {
  assert.equal(
    saveBlockedReason({ action: 'create', hasModel: true, hasName: false }),
    'Add a name to create this agent.',
  )
  assert.equal(
    saveBlockedReason({ action: 'create', hasModel: false, hasName: true }),
    'Pick a model to create this agent.',
  )
  assert.equal(
    saveBlockedReason({ action: 'create', hasModel: false, hasName: false }),
    'Add a name and pick a model to create this agent.',
  )
})

test('editing an existing agent asks to save, not to create', () => {
  assert.equal(
    saveBlockedReason({ action: 'save', hasModel: true, hasName: false }),
    'Add a name to save changes.',
  )
  assert.equal(
    saveBlockedReason({ action: 'save', hasModel: false, hasName: true }),
    'Pick a model to save changes.',
  )
})

test('a complete tool selection changes every ordinary tool without serializing protected state', () => {
  const state = { 'connector-ticket': true, protected_browser: true, web_search: true }
  const selected = completeToolSelection(state, ordinaryTools, [])
  assert.deepEqual(selected, {
    'connector-ticket': false,
    protected_browser: true,
    web_search: false,
  })
  assert.deepEqual(buildToolPolicy(ordinaryTools, selected ?? {}), {
    web_search: false,
  })
})

test('an unknown complete selection is rejected without changing any tool state', () => {
  const state = { protected_browser: true, web_search: true }
  assert.equal(completeToolSelection(state, ordinaryTools, ['unknown-tool']), null)
})
