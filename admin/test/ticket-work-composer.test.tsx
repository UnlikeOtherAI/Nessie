import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { TicketWorkChipRecord, TicketWorkSkipNotice } from '@nessie/schemas'

import {
  WORK_THREAD_WAKES_NOBODY,
  WorkThreadReadOnlyNotice,
  type WorkThreadComposer,
} from '../src/components/features/ticket-work/WorkThreadReadOnlyNotice'
import {
  refusedReentryOf,
  ticketWorkHistoryLine,
  ticketWorkStateLine,
} from '../src/components/features/ticket-work/ticket-work-presentation'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

// What a ticket's work thread and chip say before anyone acts
// (docs/standards/ticket-work.md → "What the project sees"): a board editor
// is told a message would wake nobody before sending it, and parked work the
// ticket's move back did not resume never claims that moving it back does.

const composer = (over: Partial<WorkThreadComposer>): string => renderToStaticMarkup(
  <MemoryRouter>
    <WorkThreadReadOnlyNotice
      messageOutcome="wakes"
      readOnly={false}
      taskTitle="Fix login redirect"
      ticketHref="/projects/p/board?task=t"
      {...over}
    />
  </MemoryRouter>,
)

test('a board editor sees nothing above the composer while a message wakes the work', () => {
  assert.equal(composer({}), '')
})

test('a board editor is told first when a message there would wake nobody, and why', () => {
  for (const outcome of ['work_ended', 'not_followed', 'trigger_disabled', 'config_invalid'] as const) {
    const markup = composer({ messageOutcome: outcome })
    assert.match(markup, /data-testid="work-thread-wakes-nobody"/, outcome)
    assert.ok(markup.includes(WORK_THREAD_WAKES_NOBODY[outcome]), outcome)
    assert.match(markup, /Open Fix login redirect/, outcome)
  }
  assert.match(composer({ messageOutcome: 'work_ended' }), /Move the ticket into a start-work column to start it again/)
})

test('someone who cannot edit the board gets the read-only line, whatever the work is doing', () => {
  const markup = composer({ readOnly: true, messageOutcome: 'work_ended' })
  assert.match(markup, /data-testid="work-thread-read-only"/)
  assert.match(markup, /Comment on the ticket to give the agent more information\./)
  assert.doesNotMatch(markup, /wakes nobody/)
})

const parked: TicketWorkChipRecord = {
  agent: { id: 'a1111111-1111-4111-8111-111111111111' as never, name: 'CTO' },
  endedAt: null,
  id: 'w1111111-1111-4111-8111-111111111111',
  lastWakeAt: null,
  lastWakeReason: null,
  startedAt: new Date().toISOString(),
  startedByName: 'Ondrej',
  stateReason: null,
  status: 'parked',
  thread: null,
  triggerId: 't1111111-1111-4111-8111-111111111111',
  wakeCount: 2,
  wakeLimit: 30,
}
const skip = (over: Partial<TicketWorkSkipNotice>): TicketWorkSkipNotice => ({
  agentName: 'CTO',
  at: new Date().toISOString(),
  reason: 'agent_origin',
  reentry: true,
  triggerId: parked.triggerId!,
  ...over,
})

test('parked work a move back did not resume says so, instead of promising the move resumes it', () => {
  assert.equal(
    ticketWorkStateLine(parked, skip({})),
    'Moved back by an agent, so work did not resume. A person who can edit the board can resume it.',
  )
  assert.equal(
    ticketWorkStateLine(parked, skip({ reason: 'not_board_editor' })),
    'Moved back by someone who cannot edit this board, so work did not resume.',
  )
  // A pickup skip, or another trigger's, leaves the ordinary parked line.
  const ordinary = 'Parked while the ticket is in review. Moving it back into a start-work column resumes it.'
  assert.equal(ticketWorkStateLine(parked, skip({ reentry: false })), ordinary)
  assert.equal(ticketWorkStateLine(parked, skip({ triggerId: 'another' })), ordinary)
  assert.equal(ticketWorkStateLine(parked, null), ordinary)
  assert.equal(refusedReentryOf({ ...parked, status: 'active' }, skip({})), null)
})

test('a history row names what happened, why it ended, and who caused it', () => {
  const at = new Date().toISOString()
  const base = { agentName: 'CTO', at, id: 'e1', status: 'done' as const }
  assert.match(
    ticketWorkHistoryLine({ ...base, byName: 'Ondrej', eventType: 'work_ended', reason: 'left_flow' }),
    / · CTO ended the work: the ticket left the flow · by Ondrej$/,
  )
  assert.match(
    ticketWorkHistoryLine({ ...base, byName: null, eventType: 'work_ended', reason: 'trigger_disabled' }),
    / · CTO ended the work: its trigger was turned off$/,
  )
  assert.match(
    ticketWorkHistoryLine({ ...base, byName: 'CTO', eventType: 'work_paused', reason: null, status: 'parked' }),
    / · CTO parked the work while the ticket is in review · by CTO$/,
  )
})
