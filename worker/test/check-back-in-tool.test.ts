import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'
import { CHECK_BACK_IN_MINUTES, TICKET_WORK_PURPOSE } from '@nessie/schemas'

import { resolveWithheldRunToolIds } from '../src/run/execute/run-setup.js'
import { ticketWorkToolRefusal } from '../src/run/execute/ticket-work-setup.js'
import { REMINDER_TOOL_RUNNERS } from '../src/run/pa-tools/check-back-in.js'
import { coerceJsonEncodedToolArguments } from '../src/run/tool-argument-coercion.js'
import { authorizeToolCall } from '../src/run/tool-policy.js'

// `check_back_in` is on for every agent that can talk, a ticket.work run
// included — it needs no person behind the run, which is the point — and its
// integer schema is what lets the dispatcher's coercion turn "15" into 15
// (docs/standards/ticket-work.md → "Reminders, the quiet wake and the sweep").

const definition = BUILTIN_TOOL_DEFINITIONS.find((tool) => tool.id === 'check_back_in')

test('check_back_in is a default-on scheduling tool with a runner and its range in the schema', () => {
  assert.ok(definition, 'check_back_in is defined')
  assert.equal(definition.category, 'scheduling')
  assert.equal(definition.safe, false)
  assert.equal(definition.personalAssistantOnly, undefined)
  assert.equal(definition.projectDelegatedOnly, undefined)
  assert.equal(definition.requiresExplicitGrant, undefined)
  assert.ok(Object.hasOwn(REMINDER_TOOL_RUNNERS, 'check_back_in'))
  const minutes = (definition.parameters.properties as Record<string, Record<string, unknown>>)['minutes']
  assert.deepEqual(
    [minutes?.['type'], minutes?.['minimum'], minutes?.['maximum']],
    ['integer', CHECK_BACK_IN_MINUTES.min, CHECK_BACK_IN_MINUTES.max],
  )
  assert.deepEqual(definition.parameters.required, ['minutes', 'note'])
  assert.match(definition.description, /Wake me in this thread after `minutes`/)
  assert.match(definition.description, /It replaces this ticket's pending reminder/)
})

test('a shared agent may call it with no policy, and a ticket.work run is neither withheld nor refused it', () => {
  const enabled = new Set(BUILTIN_TOOL_DEFINITIONS.map((tool) => tool.id))
  assert.deepEqual(
    authorizeToolCall('check_back_in', enabled, [...BUILTIN_TOOL_DEFINITIONS], null, null, 'shared'),
    { allowed: true },
  )
  assert.equal(resolveWithheldRunToolIds({ isHandoffTurn: false, todosEnabled: true, ticketWork: true }).has('check_back_in'), false)
  const ticketWork = { actionContext: { purpose: TICKET_WORK_PURPOSE, requestId: randomUUID() } }
  assert.equal(ticketWorkToolRefusal('check_back_in', ticketWork), null)
})

test('the dispatcher coerces "15" to 15 and leaves what is not a whole number alone', () => {
  assert.deepEqual(coerceJsonEncodedToolArguments('check_back_in', { minutes: '15', note: 'CI' }), { minutes: 15, note: 'CI' })
  assert.deepEqual(coerceJsonEncodedToolArguments('check_back_in', { minutes: '15.5', note: 'CI' }).minutes, '15.5')
})
