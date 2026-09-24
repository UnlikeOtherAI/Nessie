import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { TriggerTypePicker } from '../src/components/features/triggers/TriggerTypePicker'
import { buildSubmitPayload, getEditState } from '../src/components/features/triggers/trigger-config'
import {
  getScheduleSummary,
  getTriggerTypeLabel,
} from '../src/components/features/triggers/trigger-presentation'
import type { AgentTriggerRecord } from '../src/lib/api-client'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

// `document_changed` is in the API contract before the server accepts it on
// create (it ships its editor in T2), so the admin never offers it. T1 released
// `ticket_changed` for agents only: the picker offers it for an agent target
// and never for a workflow (docs/standards/ticket-work.md → "Nothing is
// half-exposed"). Both are named for what they are, never as a schedule.

const OFFERED = ['manual', 'scheduled', 'interval', 'webhook', 'event']

const record = (type: AgentTriggerRecord['type'], config: Record<string, unknown> = {}): AgentTriggerRecord => ({
  config,
  createdAt: new Date(0).toISOString(),
  enabled: true,
  id: `trigger-${type}`,
  status: 'active',
  type,
  updatedAt: new Date(0).toISOString(),
})

test('the picker offers ticket_changed for an agent only, and document_changed never', () => {
  const workflow = renderToStaticMarkup(<TriggerTypePicker onChange={() => {}} value="manual" />)
  const agent = renderToStaticMarkup(<TriggerTypePicker offerTicketChanged onChange={() => {}} value="manual" />)
  for (const type of OFFERED) {
    assert.match(workflow, new RegExp(`value="${type}"`), `${type} is offered to a workflow`)
    assert.match(agent, new RegExp(`value="${type}"`), `${type} is offered to an agent`)
  }
  assert.doesNotMatch(workflow, /ticket_changed/, 'a workflow can hold no ticket trigger')
  assert.match(agent, /value="ticket_changed"/, 'an agent can')
  assert.match(agent, /Ticket change/)
  for (const markup of [workflow, agent]) assert.doesNotMatch(markup, /document_changed/)
})

test('a ticket or document trigger is named for what it is, never as a schedule', () => {
  assert.equal(getTriggerTypeLabel(record('ticket_changed')), 'Ticket change')
  assert.equal(getTriggerTypeLabel(record('document_changed')), 'Document change')
  for (const type of ['ticket_changed', 'document_changed'] as const) {
    assert.doesNotMatch(getScheduleSummary(record(type)), /schedule|One-off/i)
  }
})

test('editing document_changed refuses rather than overwriting its config with events', () => {
  const form = { ...getEditState(record('document_changed'), []), name: 'Review specs' }
  assert.equal(form.triggerType, 'document_changed')
  assert.deepEqual(
    buildSubmitPayload(form, 'edit', record('document_changed')),
    { error: 'This trigger type cannot be edited here yet.' },
  )
})

test('editing a ticket trigger posts its typed config back, never an event list', () => {
  const stored = {
    boardId: '10000000-0000-4000-8000-000000000003',
    pickup: { assignOnPickup: true, columnIds: ['10000000-0000-4000-8000-000000000005'] },
    follow: { includeSourceEvents: false, kinds: ['comment', 'moved'] },
    endOn: [{ category: 'done' }],
    limits: { startsPerDay: 5, wakesPerTicket: 12 },
    instructions: { general: 'Triage it.', onPickup: 'Comment a plan.' },
  }
  const trigger = record('ticket_changed', stored)
  const form = { ...getEditState(trigger, []), name: 'Pick up' }
  const result = buildSubmitPayload(form, 'edit', trigger)
  assert.ok('payload' in result, JSON.stringify(result))
  assert.deepEqual(result.payload.config, {
    boardId: stored.boardId,
    pickup: { assignOnPickup: true, columns: [{ id: stored.pickup.columnIds[0] }] },
    follow: stored.follow,
    endOn: [{ category: 'done' }],
    limits: { startsPerDay: 5, wakesPerTicket: 12 },
    // A trigger stored before the quiet wake reads back with its default.
    quietWakeMinutes: 30,
    instructions: { general: 'Triage it.', onPickup: 'Comment a plan.' },
  })
  assert.equal(result.payload.nextRunAt, undefined, 'a ticket trigger has no schedule')
})
