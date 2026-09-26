import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DocumentChangedTriggerConfigSchema } from '@nessie/schemas'

import { TriggerTypePicker } from '../src/components/features/triggers/TriggerTypePicker'
import { buildSubmitPayload, getEditState } from '../src/components/features/triggers/trigger-config'
import {
  canRunTriggerNow,
  getScheduleSummary,
  getTriggerTypeLabel,
} from '../src/components/features/triggers/trigger-presentation'
import type { AgentTriggerRecord } from '../src/lib/api-client'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

// T1 released `ticket_changed` and T2 `document_changed`, for agents only: the
// picker offers both for an agent target and never for a workflow
// (docs/standards/ticket-work.md → "Nothing is half-exposed"). Both are named
// for what they are, never as a schedule, neither is run by hand, and editing
// either posts its own typed config back — never an event list.

const OFFERED = ['manual', 'scheduled', 'interval', 'webhook', 'event']
const AGENT_ONLY = ['ticket_changed', 'document_changed']

const record = (type: AgentTriggerRecord['type'], config: Record<string, unknown> = {}): AgentTriggerRecord => ({
  config,
  createdAt: new Date(0).toISOString(),
  enabled: true,
  id: `trigger-${type}`,
  status: 'active',
  type,
  updatedAt: new Date(0).toISOString(),
})

test('the picker offers ticket_changed and document_changed for an agent only', () => {
  const workflow = renderToStaticMarkup(<TriggerTypePicker onChange={() => {}} value="manual" />)
  const agent = renderToStaticMarkup(<TriggerTypePicker agentTarget onChange={() => {}} value="manual" />)
  for (const type of OFFERED) {
    assert.match(workflow, new RegExp(`value="${type}"`), `${type} is offered to a workflow`)
    assert.match(agent, new RegExp(`value="${type}"`), `${type} is offered to an agent`)
  }
  for (const type of AGENT_ONLY) {
    assert.doesNotMatch(workflow, new RegExp(type), `a workflow can hold no ${type} trigger`)
    assert.match(agent, new RegExp(`value="${type}"`), `an agent can hold a ${type} trigger`)
  }
  assert.match(agent, /Ticket change/)
  assert.match(agent, /Document change/)
  assert.doesNotMatch(workflow, /Document change|Ticket change/)
})

test('a ticket or document trigger is named for what it is, never as a schedule, and never run by hand', () => {
  assert.equal(getTriggerTypeLabel(record('ticket_changed')), 'Ticket change')
  assert.equal(getTriggerTypeLabel(record('document_changed')), 'Document change')
  for (const type of AGENT_ONLY) {
    assert.doesNotMatch(getScheduleSummary(record(type as AgentTriggerRecord['type'])), /schedule|One-off/i)
    assert.equal(canRunTriggerNow(record(type as AgentTriggerRecord['type'])), false, `${type} has no Run now`)
  }
  assert.equal(canRunTriggerNow(record('manual')), true)
  assert.equal(canRunTriggerNow({ status: 'paused', type: 'manual' }), false)
})

test('editing a document trigger posts its typed config back, clearing what was taken off', () => {
  const stored = {
    spaceId: '10000000-0000-4000-8000-000000000001',
    folderPageId: '10000000-0000-4000-8000-000000000002',
    pageIds: null,
    labels: ['spec'],
    kinds: ['document'],
    fireOn: 'publish',
    quietSeconds: 240,
    includeAgentEdits: true,
    instructions: { general: 'Review it.' },
  }
  const trigger = record('document_changed', stored)
  const loaded = getEditState(trigger, [])
  assert.equal(loaded.triggerType, 'document_changed')
  assert.deepEqual(loaded.document, {
    spaceId: stored.spaceId,
    folderPageId: stored.folderPageId,
    pageIds: [],
    labels: ['spec'],
    kinds: ['document'],
    fireOn: 'publish',
    quietSeconds: '240',
    includeAgentEdits: true,
    instructions: 'Review it.',
  }, 'the stored config is read back into the form')

  // The person takes the folder off and changes the window.
  const form = { ...loaded, name: 'Review specs', document: { ...loaded.document!, folderPageId: '', quietSeconds: '60' } }
  const result = buildSubmitPayload(form, 'edit', trigger)
  assert.ok('payload' in result, JSON.stringify(result))
  assert.deepEqual(result.payload.config, {
    spaceId: stored.spaceId,
    folderPageId: null,
    pageIds: null,
    labels: ['spec'],
    kinds: ['document'],
    fireOn: 'publish',
    quietSeconds: 60,
    includeAgentEdits: true,
    instructions: { general: 'Review it.' },
  })
  assert.equal(result.payload.nextRunAt, undefined, 'a document trigger has no schedule')
  // What the update route parses once it has merged the edit over the stored
  // config and dropped every key the edit cleared.
  const merged = Object.fromEntries(Object.entries({ ...stored, ...result.payload.config })
    .filter(([, value]) => value !== null))
  assert.ok(DocumentChangedTriggerConfigSchema.safeParse(merged).success)
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
    // And one stored before waiting for an offline machine was an option, with its own (T5).
    waitingMachineHours: 24,
    instructions: { general: 'Triage it.', onPickup: 'Comment a plan.' },
  })
  assert.equal(result.payload.nextRunAt, undefined, 'a ticket trigger has no schedule')
})
