import assert from 'node:assert/strict'
import test from 'node:test'

import { TicketChangedTriggerConfigSchema } from '@nessie/schemas'

import {
  buildTicketConfig,
  columnEndsWork,
  getDefaultTicketState,
  groupTicketRefusals,
  isTicketTargetChannel,
} from '../src/components/features/triggers/ticket-trigger-form'
import {
  ticketDeliveryLine,
  ticketWorkStateLine,
} from '../src/components/features/ticket-work/ticket-work-presentation'
import type { ChannelRecord } from '../src/lib/api-client'

// The Triggers editor's ticket_changed half (docs/standards/ticket-work.md):
// what it posts is the typed config the server parses, a refusal lands on the
// field it names, and only a public project channel is offered.

const BOARD = '10000000-0000-4000-8000-000000000003'
const DOING = '10000000-0000-4000-8000-000000000005'

test('what the editor posts is the typed config the server accepts', () => {
  const state = {
    ...getDefaultTicketState({ boardId: BOARD, pickupColumnIds: [DOING] }),
    instructions: { ...getDefaultTicketState().instructions, general: 'Triage it.', onReminder: '  ' },
  }
  const built = buildTicketConfig(state)
  assert.ok('config' in built, JSON.stringify(built))
  const parsed = TicketChangedTriggerConfigSchema.safeParse(built.config)
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  assert.deepEqual(parsed.data.pickup, { assignOnPickup: true, columns: [{ id: DOING }] })
  assert.deepEqual(parsed.data.instructions, { general: 'Triage it.' }, 'an empty section is left out')
  assert.deepEqual(parsed.data.endOn, [{ category: 'todo' }, { category: 'done' }])

  // No start-work column: a follow-only trigger, posted as such.
  const followOnly = buildTicketConfig({ ...state, pickupColumnIds: [] })
  assert.ok('config' in followOnly)
  assert.equal(followOnly.config.pickup, null)
})

test('the editor refuses the two things it can see itself, on their fields', () => {
  assert.deepEqual(buildTicketConfig(getDefaultTicketState()), {
    error: 'Choose the board whose tickets this trigger works.', field: 'boardId',
  })
  const noInstructions = buildTicketConfig(getDefaultTicketState({ boardId: BOARD }))
  assert.ok('error' in noInstructions)
  assert.equal(noInstructions.field, 'instructions')
  const overLimit = buildTicketConfig({
    ...getDefaultTicketState({ boardId: BOARD }),
    instructions: { ...getDefaultTicketState().instructions, general: 'x' },
    wakesPerTicket: '500',
  })
  assert.ok('error' in overLimit)
  assert.equal(overLimit.field, 'limits')
})

test('a server refusal lands on the field its path names', () => {
  const grouped = groupTicketRefusals({
    refusals: [
      { path: 'pickup.columns[0]', reason: 'column "In progress" is already a start-work column of "Pick up".' },
      { path: 'targetChannelId', reason: '#leads is protected.' },
      { path: 'somethingElse', reason: 'unknown' },
    ],
  })
  assert.deepEqual(grouped.fields, {
    pickup: 'column "In progress" is already a start-work column of "Pick up".',
    targetChannelId: '#leads is protected.',
  })
  assert.deepEqual(grouped.rest, ['somethingElse: unknown'])
  assert.deepEqual(groupTicketRefusals(null), { fields: {}, rest: [] })
})

test('a column that ends the work cannot start it', () => {
  const state = getDefaultTicketState()
  assert.equal(columnEndsWork(state, { category: 'done', id: 'd' }), true)
  assert.equal(columnEndsWork(state, { category: 'in_progress', id: DOING }), false)
  assert.equal(columnEndsWork({ ...state, endOnColumnIds: [DOING] }, { category: 'in_progress', id: DOING }), true)
})

test('only a live, ordinary, public project channel may carry ticket work', () => {
  const channel = (extra: Partial<ChannelRecord>) => ({
    archivedAt: null, id: 'c', label: 'eng', scope: 'project', type: 'standard', visibility: 'public', ...extra,
  }) as ChannelRecord
  assert.equal(isTicketTargetChannel(channel({})), true)
  for (const refused of [
    { visibility: 'protected' as const },
    { type: 'dm' as const },
    { systemChannelType: 'personal_assistant' as const },
    { isGroupDm: true },
    { scope: 'standalone' as const },
    { archivedAt: new Date(0).toISOString() },
  ]) {
    assert.equal(isTicketTargetChannel(channel(refused)), false, JSON.stringify(refused))
  }
})

test('a ticket delivery and a stopped record say why, in words', () => {
  assert.match(
    ticketDeliveryLine({
      eventType: 'column_entered', originKind: 'agent', outcome: 'skipped', skipReason: 'agent_origin',
      taskEventId: '10000000-0000-4000-8000-000000000011', taskId: '10000000-0000-4000-8000-000000000012',
    }) ?? '',
    /Moved by an agent, so work did not start/,
  )
  assert.equal(
    ticketDeliveryLine({
      eventType: 'comment_added', originKind: 'session', outcome: 'follow', wakeReason: 'ticket_commented',
      taskEventId: '10000000-0000-4000-8000-000000000011', taskId: '10000000-0000-4000-8000-000000000012',
      workId: '10000000-0000-4000-8000-000000000013',
    }),
    'Woke the agent: a comment.',
  )
  assert.equal(ticketDeliveryLine({ prompt: 'webhook payload' }), null, 'any other trigger keeps its raw payload')
  assert.match(
    ticketWorkStateLine({
      agent: { id: 'a', name: 'CTO' }, endedAt: new Date().toISOString(), id: 'w', lastWakeAt: null,
      lastWakeReason: null, startedAt: new Date().toISOString(), startedByName: null, stateReason: 'limit_wakes',
      status: 'failed', thread: null, triggerId: null, wakeCount: 30, wakeLimit: 30,
    } as never) ?? '',
    /^Stopped: 30 wakes used\. Move the ticket out of and back into a start-work column to continue\.$/,
  )
})
