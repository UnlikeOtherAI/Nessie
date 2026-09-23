import assert from 'node:assert/strict'
import test from 'node:test'

import { SYSTEM_TOOL_DEFINITIONS } from '../src/index.js'

const TICKET_TOOL_IDS = [
  'ticket_list',
  'ticket_read',
  'ticket_checklist_read',
  'ticket_checklist_apply',
  'ticket_checklist_step_update',
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

// A shared agent is lent these only in its own project channel and holds no
// project_list, so a required projectId was an id it could not find.
test('a lendable project tool never requires a projectId and says what omitting it means', () => {
  const lendable = SYSTEM_TOOL_DEFINITIONS.filter((tool) => tool.projectDelegatedOnly)
  const takingProject = lendable.filter((tool) => {
    const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties
    return properties !== undefined && 'projectId' in properties
  })
  assert.deepEqual(
    takingProject.map((tool) => tool.id).sort(),
    ['ticket_board_read', 'ticket_create', 'ticket_label_create', 'ticket_labels_read', 'ticket_list'],
  )
  for (const tool of takingProject) {
    const parameters = tool.parameters as {
      properties: { projectId: { description: string } }
      required?: string[]
    }
    assert.equal(parameters.required?.includes('projectId') ?? false, false, `${tool.id} requires projectId`)
    const description = parameters.properties.projectId.description
    assert.match(description, /An agent working in its own project channel omits it/)
    // Omitting it is promised only where the handler honours it: the PA is
    // never defaulted, so it is told to name the project — and project_list is
    // addressed to it by name, never offered to an agent that does not hold it.
    assert.match(description, /The Personal Assistant always names it, from project_list/)
    assert.doesNotMatch(description, /otherwise resolve it with project_list/)
  }
  const list = lendable.find((tool) => tool.id === 'ticket_list')
  assert.doesNotMatch(list?.description ?? '', /project_list/)
})

test('ticket removal is a reversible status transition, not a destructive tool', () => {
  assert.equal(SYSTEM_TOOL_DEFINITIONS.some((tool) => tool.id === 'ticket_delete'), false)
  const transition = SYSTEM_TOOL_DEFINITIONS.find((tool) => tool.id === 'ticket_transition')
  assert.ok(transition)
  assert.match(transition.description, /cancelled/)
  assert.match(transition.description, /restore/)
})
