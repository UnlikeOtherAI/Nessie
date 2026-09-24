import assert from 'node:assert/strict'
import test from 'node:test'

import { StandingPolicyBindRefusalReasonSchema, TicketChangedTriggerConfigSchema } from '@nessie/schemas'

import {
  buildTicketConfig,
  columnEndsWork,
  getDefaultTicketState,
  groupTicketRefusals,
  isTicketTargetChannel,
  ticketStateFromConfig,
} from '../src/components/features/triggers/ticket-trigger-form'
import {
  ticketDeliveryLine,
  ticketWorkQuestionLine,
  ticketWorkReminderLine,
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
  // A run the standing-policy binder bound no machine to, one plain sentence per reason, none naming a machine.
  for (const reason of StandingPolicyBindRefusalReasonSchema.options) {
    const line = ticketDeliveryLine({
      kind: 'standing_policy_refused', reason, runId: '10000000-0000-4000-8000-000000000014',
      taskId: '10000000-0000-4000-8000-000000000012', workId: '10000000-0000-4000-8000-000000000013',
    })
    assert.match(line ?? '', /^Ran without a machine: [a-z].+\.$/, reason)
  }
  assert.equal(
    ticketDeliveryLine({
      kind: 'standing_policy_refused', reason: 'machine_unavailable', runId: '10000000-0000-4000-8000-000000000014',
      taskId: '10000000-0000-4000-8000-000000000012', workId: '10000000-0000-4000-8000-000000000013',
    }),
    'Ran without a machine: the machine was offline or no longer offers its coding tools.',
  )
  assert.match(
    ticketWorkStateLine({
      agent: { id: 'a', name: 'CTO' }, endedAt: new Date().toISOString(), id: 'w', lastWakeAt: null,
      lastWakeReason: null, startedAt: new Date().toISOString(), startedByName: null, stateReason: 'limit_wakes',
      status: 'failed', thread: null, triggerId: null, wakeCount: 30, wakeLimit: 30,
    } as never) ?? '',
    /^Stopped: 30 wakes used\. Move the ticket out of and back into a start-work column to continue\.$/,
  )
})

test('the quiet wake posts its minutes, posts null when off, reads back, and refuses out of range on its field', () => {
  const base = {
    ...getDefaultTicketState({ boardId: BOARD, pickupColumnIds: [DOING] }),
    instructions: { ...getDefaultTicketState().instructions, general: 'Triage it.' },
  }
  const onByDefault = buildTicketConfig(base)
  assert.ok('config' in onByDefault)
  assert.equal(onByDefault.config.quietWakeMinutes, 30)
  assert.equal(TicketChangedTriggerConfigSchema.parse(onByDefault.config).quietWakeMinutes, 30)
  const off = buildTicketConfig({ ...base, quietWakeEnabled: false, quietWakeMinutes: 'anything' })
  assert.ok('config' in off)
  assert.equal(off.config.quietWakeMinutes, null)
  assert.equal(TicketChangedTriggerConfigSchema.parse(off.config).quietWakeMinutes, null)
  for (const minutes of ['10', '1441', '20.5', '']) {
    const refused = buildTicketConfig({ ...base, quietWakeMinutes: minutes })
    assert.ok('error' in refused, minutes)
    assert.equal(refused.field, 'quietWakeMinutes')
    assert.match(refused.error, /from 15 to 1440, or off/)
  }
  // A stored trigger reads back as the editor shows it.
  assert.deepEqual(
    [ticketStateFromConfig({ boardId: BOARD, quietWakeMinutes: null }).quietWakeEnabled,
      ticketStateFromConfig({ boardId: BOARD, quietWakeMinutes: 45 }).quietWakeMinutes,
      ticketStateFromConfig({ boardId: BOARD }).quietWakeMinutes],
    [false, '45', '30'],
  )
  assert.deepEqual(
    groupTicketRefusals({ refusals: [{ path: 'quietWakeMinutes', reason: 'too short' }] }).fields,
    { quietWakeMinutes: 'too short' },
  )
})

test('the chip says when the agent checks back, and what it waits on', () => {
  const record = {
    agent: { id: 'a', name: 'CTO' }, endedAt: null, id: 'w', lastWakeAt: null, lastWakeReason: null,
    startedAt: new Date().toISOString(), startedByName: null, stateReason: null, status: 'active', thread: null,
    triggerId: null, wakeCount: 3, wakeLimit: 30, pendingReminder: null, awaitingAnswerAt: null,
  }
  assert.equal(ticketWorkReminderLine(record as never), null)
  assert.equal(ticketWorkQuestionLine(record as never), null)
  const due = new Date()
  due.setHours(14, 35, 0, 0)
  const line = ticketWorkReminderLine({
    ...record, pendingReminder: { id: 'r', dueAt: due.toISOString(), note: 'waiting for CI' },
  } as never)
  // Today's time as this viewer's locale writes it.
  const at = due.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  assert.equal(line, `Checking back at ${at} — waiting for CI`)
  assert.equal(
    ticketWorkQuestionLine({ ...record, awaitingAnswerAt: due.toISOString() } as never),
    `Waiting for an answer on the ticket since ${at}`,
  )
})
