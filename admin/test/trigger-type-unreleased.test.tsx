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

// `ticket_changed` and `document_changed` are in the API contract before the
// server accepts either on create. The admin must never offer them, and must
// describe a row of one as what it is rather than falling through to the
// schedule wording.

const UNRELEASED = ['ticket_changed', 'document_changed'] as const

const record = (type: AgentTriggerRecord['type']): AgentTriggerRecord => ({
  config: {},
  createdAt: new Date(0).toISOString(),
  enabled: true,
  id: `trigger-${type}`,
  status: 'active',
  type,
  updatedAt: new Date(0).toISOString(),
})

test('the create picker offers neither unreleased type', () => {
  const markup = renderToStaticMarkup(<TriggerTypePicker onChange={() => {}} value="manual" />)
  for (const type of ['manual', 'scheduled', 'interval', 'webhook', 'event']) {
    assert.match(markup, new RegExp(`value="${type}"`), `${type} is offered`)
  }
  for (const type of UNRELEASED) {
    assert.doesNotMatch(markup, new RegExp(type), `${type} is not offered`)
  }
})

test('a row of an unreleased type is named for what it is, never as a schedule', () => {
  assert.equal(getTriggerTypeLabel(record('ticket_changed')), 'Ticket change')
  assert.equal(getTriggerTypeLabel(record('document_changed')), 'Document change')
  for (const type of UNRELEASED) {
    assert.doesNotMatch(getScheduleSummary(record(type)), /schedule|One-off/i)
  }
})

test('editing an unreleased type refuses rather than overwriting its config with events', () => {
  for (const type of UNRELEASED) {
    const form = { ...getEditState(record(type), []), name: 'Pick up tickets' }
    assert.equal(form.triggerType, type)
    assert.deepEqual(
      buildSubmitPayload(form, 'edit', record(type)),
      { error: 'This trigger type cannot be edited here yet.' },
    )
  }
})
