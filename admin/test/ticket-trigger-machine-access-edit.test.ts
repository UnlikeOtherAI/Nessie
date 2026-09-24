import assert from 'node:assert/strict'
import test from 'node:test'

import { ticketStateFromConfig } from '../src/components/features/triggers/ticket-trigger-form'
import {
  machineAccessEditWarning,
  machineAccessSavedLine,
  ticketEditPausesMachineAccess,
} from '../src/components/features/triggers/ticket-trigger-machine-access-edit'

// Whether saving a ticket trigger's editor pauses its live machine access
// (docs/standards/ticket-work.md → "Limits and digests"): every pinned field
// does, raising a limit does, lowering one does not, and neither does a field
// the policy never pinned.

const BOARD = '10000000-0000-4000-8000-000000000003'
const DOING = '10000000-0000-4000-8000-000000000005'
const REVIEW = '10000000-0000-4000-8000-000000000006'
const CHANNEL = '10000000-0000-4000-8000-000000000007'
const OTHER_CHANNEL = '10000000-0000-4000-8000-000000000008'

const stored = {
  config: {
    boardId: BOARD,
    endOn: [{ category: 'todo' }, { category: 'done' }],
    follow: { includeSourceEvents: false, kinds: ['comment', 'moved'] },
    instructions: { general: 'Triage every ticket.', onPickup: 'Comment a plan.' },
    limits: { startsPerDay: 20, wakesPerTicket: 30 },
    pickup: { assignOnPickup: true, columnIds: [DOING] },
    quietWakeMinutes: 30,
  },
  targetChannelId: CHANNEL,
}

type Ticket = ReturnType<typeof ticketStateFromConfig>
const formWith = (patch: Partial<Ticket> = {}, targetChannelId = CHANNEL) => ({
  targetChannelId,
  ticket: { ...ticketStateFromConfig(stored.config), ...patch },
})
const pauses = (patch: Partial<Ticket> = {}, channel?: string) =>
  ticketEditPausesMachineAccess(stored, formWith(patch, channel))

test('the form as stored, reordered or with a lower limit keeps machine access on', () => {
  assert.equal(pauses(), false)
  assert.equal(pauses({ followKinds: ['moved', 'comment'] }), false, 'a reorder changes nothing')
  assert.equal(pauses({ wakesPerTicket: '10' }), false)
  assert.equal(pauses({ startsPerDay: '5', wakesPerTicket: '10' }), false)
  // A section left empty posts nothing, and the server keeps the stored one.
  const ticket = ticketStateFromConfig(stored.config)
  assert.equal(pauses({ instructions: { ...ticket.instructions, onPickup: '' } }), false)
})

test('every pinned field, and a raised limit, pauses it', () => {
  const ticket = ticketStateFromConfig(stored.config)
  const cases: [string, boolean][] = [
    ['an edited instruction', pauses({ instructions: { ...ticket.instructions, general: 'Fix every ticket.' } })],
    ['a new instruction section', pauses({ instructions: { ...ticket.instructions, onQueued: 'Say you wait.' } })],
    ['another start-work column', pauses({ pickupColumnIds: [DOING, REVIEW] })],
    ['no start-work column', pauses({ pickupColumnIds: [] })],
    ['assigning on pickup', pauses({ assignOnPickup: false })],
    ['another wake kind', pauses({ followKinds: ['comment', 'moved', 'labels'] })],
    ['connected-board events', pauses({ includeSourceEvents: true })],
    ['another end column', pauses({ endOnColumnIds: [REVIEW] })],
    ['no To do end', pauses({ endOnTodo: false })],
    ['the quiet wake', pauses({ quietWakeMinutes: '45' })],
    ['the quiet wake off', pauses({ quietWakeEnabled: false })],
    ['a higher wake limit', pauses({ wakesPerTicket: '31' })],
    ['a lower limit beside a higher one', pauses({ startsPerDay: '40', wakesPerTicket: '10' })],
    ['the channel', pauses({}, OTHER_CHANNEL)],
    ['the board', pauses({ boardId: '10000000-0000-4000-8000-000000000009' })],
  ]
  for (const [label, paused] of cases) assert.equal(paused, true, label)
})

test('a form that would not save, or a trigger that is not a ticket trigger, warns of nothing', () => {
  const ticket = ticketStateFromConfig(stored.config)
  assert.equal(pauses({ instructions: { ...ticket.instructions, general: '' } }), false)
  assert.equal(ticketEditPausesMachineAccess({ config: {}, targetChannelId: CHANNEL }, formWith()), false)
  assert.equal(ticketEditPausesMachineAccess(stored, { targetChannelId: CHANNEL }), false)
})

test('the warning before Save and the line after it', () => {
  assert.equal(machineAccessEditWarning('Ondrej'), 'Saving pauses Ondrej’s machine access until they re-confirm.')
  assert.equal(
    machineAccessSavedLine({ authorName: 'Ondrej', fields: ['the general instructions'], kind: 'suspended' }),
    'Saved. Ondrej’s machine access is paused until they confirm it again; tickets being worked wait for it.',
  )
  assert.equal(
    machineAccessSavedLine({ kind: 'limits_lowered' }),
    'Saved. Machine access stays on: lowering a limit needs no new confirmation.',
  )
})
