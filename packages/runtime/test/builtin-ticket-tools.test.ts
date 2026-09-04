import assert from 'node:assert/strict'
import test from 'node:test'

import { SYSTEM_TOOL_DEFINITIONS } from '../src/index.js'

const TICKET_TOOL_IDS = [
  'ticket_list',
  'ticket_read',
  'ticket_board_read',
  'ticket_create',
  'ticket_update',
  'ticket_assign',
  'ticket_move',
  'ticket_transition',
  'ticket_iteration_set',
  'ticket_archive_done',
]

test('project-ticket operations are personal-assistant tools in the projects category', () => {
  const tools = TICKET_TOOL_IDS.map((id) => {
    const tool = SYSTEM_TOOL_DEFINITIONS.find((definition) => definition.id === id)
    assert.ok(tool, `Expected ${id} in SYSTEM_TOOL_DEFINITIONS`)
    return tool
  })

  assert.deepEqual(tools.map((tool) => tool.category), Array(TICKET_TOOL_IDS.length).fill('projects'))
  assert.deepEqual(tools.map((tool) => tool.personalAssistantOnly), Array(TICKET_TOOL_IDS.length).fill(true))
})

test('ticket removal is a reversible status transition, not a destructive tool', () => {
  assert.equal(SYSTEM_TOOL_DEFINITIONS.some((tool) => tool.id === 'ticket_delete'), false)
  const transition = SYSTEM_TOOL_DEFINITIONS.find((tool) => tool.id === 'ticket_transition')
  assert.ok(transition)
  assert.match(transition.description, /cancelled/)
  assert.match(transition.description, /restore/)
})
