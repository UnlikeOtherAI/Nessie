import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILTIN_TOOL_DEFINITIONS } from '../src/builtin-tools.js'
import {
  SHEET_TOOL_DEFINITIONS,
  SHEET_TOOL_IDS,
} from '../src/builtin-sheet-tools.js'

// What a tool *definition* can get wrong is narrow and specific: a required
// argument nobody declared, an enum the handler does not accept, a category
// that puts the tool somewhere a person would not look, or a `safe: true` on
// something that writes. None of those fail a type check and all of them reach
// a model.

const byId = new Map(SHEET_TOOL_DEFINITIONS.map((tool) => [tool.id, tool]))
const tool = (id: string) => {
  const found = byId.get(id)
  assert.ok(found, `${id} is not defined`)
  return found
}

test('the twelve tools of agent-tools.md are all defined, and only those', () => {
  assert.deepEqual(
    SHEET_TOOL_DEFINITIONS.map((definition) => definition.id).sort(),
    [
      'sheet_create',
      'sheet_describe',
      'sheet_export',
      'sheet_filter',
      'sheet_find',
      'sheet_format_range',
      'sheet_read_range',
      'sheet_replace',
      'sheet_structure',
      'sheet_tabs',
      'sheet_versions',
      'sheet_write_range',
    ],
  )
})

test('every sheet tool is registered as a builtin', () => {
  const registered = new Set(BUILTIN_TOOL_DEFINITIONS.map((definition) => definition.id))
  for (const id of SHEET_TOOL_IDS) {
    assert.ok(registered.has(id), `${id} is defined but never spread into BUILTIN_TOOL_DEFINITIONS`)
  }
})

test('every sheet tool belongs to the spreadsheets category', () => {
  for (const definition of SHEET_TOOL_DEFINITIONS) {
    assert.equal(definition.category, 'spreadsheets', `${definition.id} is filed elsewhere`)
  }
})

test('exactly the read-only tools are safe', () => {
  const safe = SHEET_TOOL_DEFINITIONS.filter((definition) => definition.safe).map((d) => d.id)
  // Everything else writes — and a write is `safe: false` even though there is
  // no approval gate on it, because "safe" describes the call, not the policy.
  assert.deepEqual(safe.sort(), ['sheet_describe', 'sheet_find', 'sheet_read_range'])
})

test('no sheet tool is gated behind the personal assistant or an explicit grant', () => {
  // An agent working in a spreadsheet is doing its own work in its own
  // organisation's document, not borrowing a person's delegated authority.
  for (const definition of SHEET_TOOL_DEFINITIONS) {
    assert.equal(definition.personalAssistantOnly, undefined, definition.id)
    assert.equal(definition.requiresExplicitGrant, undefined, definition.id)
    assert.equal(definition.requiresApproval, undefined, definition.id)
  }
})

test('every tool but sheet_create is addressed by pageId; sheet_create is addressed by space', () => {
  for (const definition of SHEET_TOOL_DEFINITIONS) {
    if (definition.id === 'sheet_create') {
      assert.deepEqual(definition.parameters.required, ['spaceId', 'title'])
      continue
    }
    assert.ok(
      definition.parameters.required?.includes('pageId'),
      `${definition.id} does not require a pageId`,
    )
  }
})

test('the sheet argument is separate from the range everywhere both appear', () => {
  // `A1Schema` refuses `Sheet1!B2` deliberately, so a tool that folded the
  // sheet into the range would be unusable rather than merely inconsistent.
  for (const definition of SHEET_TOOL_DEFINITIONS) {
    const properties = definition.parameters.properties as Record<string, { description?: string }>
    if (!properties.range) continue
    assert.ok(
      properties.sheet || definition.id === 'sheet_write_range',
      `${definition.id} takes a range but no sheet`,
    )
    assert.doesNotMatch(
      properties.range.description ?? '',
      /Sheet1!/,
      `${definition.id} documents a sheet-qualified range`,
    )
  }
})

test('the action enums match what the handlers dispatch on', () => {
  const enumOf = (id: string, field: string): string[] => {
    const properties = tool(id).parameters.properties as Record<string, { enum?: string[] }>
    return properties[field]?.enum ?? []
  }
  assert.deepEqual(enumOf('sheet_versions', 'action'), ['list', 'save', 'restore'])
  assert.deepEqual(enumOf('sheet_filter', 'action'), ['get', 'set', 'clear', 'reapply'])
  assert.deepEqual(enumOf('sheet_export', 'format'), ['xlsx', 'csv'])
  assert.deepEqual(enumOf('sheet_read_range', 'values'), ['display', 'raw', 'formula'])
  assert.deepEqual(enumOf('sheet_write_range', 'mode'), ['overwrite', 'insertRowsBelow'])

  // Merges and tab colours are absent on purpose: IronCalc 0.8 exposes neither
  // API on either binding (decisions.md), so offering them would be a promise
  // the engine cannot keep.
  const structure = enumOf('sheet_structure', 'action')
  assert.ok(!structure.includes('merge'))
  assert.ok(!structure.includes('unmerge'))
  assert.ok(!enumOf('sheet_tabs', 'action').includes('setColor'))
  assert.deepEqual(enumOf('sheet_tabs', 'action'), [
    'add', 'rename', 'delete', 'duplicate', 'move', 'hide', 'unhide',
  ])
})

test('the destructive tools say a version is saved first', () => {
  // The whole design rests on this being discoverable by the model rather than
  // only by the write door: there is no approval gate, so an agent has to know
  // that a delete is reversible and how to reverse it.
  assert.match(tool('sheet_structure').description, /version is saved first/i)
  assert.match(tool('sheet_tabs').description, /saves a version first/i)
  assert.match(tool('sheet_versions').description, /restore/i)
})

test('sheet_describe reads no cells and says so', () => {
  assert.match(tool('sheet_describe').description, /without reading any cells/i)
  assert.deepEqual(Object.keys(tool('sheet_describe').parameters.properties), ['pageId'])
})

test('the read cap is documented where an agent will meet it', () => {
  assert.match(tool('sheet_read_range').description, /10,000 cells is refused/i)
})
