import assert from 'node:assert/strict'
import test from 'node:test'

import {
  STANDING_ACCESS_STATE,
  standingAccessEndCopy,
  standingAccessStateLine,
  standingAccessTicketsLine,
} from '../src/components/features/executors/executor-standing-access-presentation.js'

/**
 * An executor's Standing access panel
 * (docs/standards/ticket-work-machine-access.md → "What the screens show"):
 * each row says its state, whose move it is when nothing runs, how many
 * tickets are working here, and what End does before it is pressed.
 */

const trigger = { id: '11111111-0000-4000-8000-000000000001', name: 'Pick up tickets' }

test('each state reads as a plain label', () => {
  assert.equal(STANDING_ACCESS_STATE.live.label, 'Live')
  assert.equal(STANDING_ACCESS_STATE.suspended.label, 'Suspended')
  assert.equal(STANDING_ACCESS_STATE.preparing.label, 'Awaiting confirmation')
  assert.equal(STANDING_ACCESS_STATE.ended.label, 'Ended')
})

test('a suspended row says why and that its author must confirm again', () => {
  assert.equal(
    standingAccessStateLine({ authorName: 'Ondrej', status: 'suspended', suspendedReason: 'trigger_changed' }),
    'The trigger was edited, so it waits until Ondrej confirms again.',
  )
  assert.equal(
    standingAccessStateLine({ authorName: 'Ondrej', status: 'suspended', suspendedReason: 'descriptor_changed' }),
    'The reviewed setup of one of its machines changed, so it waits until Ondrej confirms again.',
  )
  assert.equal(
    standingAccessStateLine({ authorName: 'Ondrej', status: 'suspended', suspendedReason: null }),
    'Something it relies on changed, so it waits until Ondrej confirms again.',
  )
})

test('a card still out says nothing runs until it is confirmed; a live row needs no line', () => {
  assert.equal(
    standingAccessStateLine({ authorName: 'Alex', status: 'preparing', suspendedReason: null }),
    'Nothing runs here until Alex confirms it.',
  )
  assert.equal(standingAccessStateLine({ authorName: 'Alex', status: 'live', suspendedReason: null }), null)
})

test('the ticket count reads as words', () => {
  assert.equal(standingAccessTicketsLine(0), 'No tickets working here')
  assert.equal(standingAccessTicketsLine(1), '1 ticket working here')
  assert.equal(standingAccessTicketsLine(2), '2 tickets working here')
})

test('End says what it cancels and who has to set it up again', () => {
  const copy = standingAccessEndCopy({ authorName: 'Ondrej', trigger })
  assert.equal(copy.title, 'End standing access for “Pick up tickets”?')
  assert.equal(copy.confirmLabel, 'End standing access')
  assert.match(copy.body, /^Ending it cancels this trigger’s tickets that are working or waiting, /)
  assert.match(copy.body, /closes their coding sessions on its machines\./)
  assert.match(copy.body, /Ondrej has to set it up again/)
  assert.equal(standingAccessEndCopy({ authorName: 'Ondrej', trigger: null }).title,
    'End standing access for a deleted trigger?')
})
