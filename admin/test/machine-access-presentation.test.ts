import assert from 'node:assert/strict'
import test from 'node:test'

import type { StandingPolicyMachineOption, TriggerMachineAccessView } from '@nessie/schemas'

import {
  machineAccessLimitsLine,
  machineAccessStateLine,
  machineAccessTicketLine,
  machineOptionRefusal,
  sharedCodingRoots,
} from '../src/components/features/triggers/machine-access-presentation'

// A ticket trigger's Machine access section and its setup form, in words
// (docs/standards/ticket-work-machine-access.md → "What the screens show").

const AUTHOR = { name: 'Ondrej', userId: '10000000-0000-4000-8000-000000000001' }
const POLICY: NonNullable<TriggerMachineAccessView['policy']> = {
  allowAnyCommand: false, confirmedAt: null, createdAt: '2026-09-23T09:00:00.000Z', endedAt: null, endedByName: null,
  endedReason: null, id: '10000000-0000-4000-8000-000000000002', limits: { dailyUsd: 60, ticketHours: 4, ticketUsd: 20 },
  machineCount: 2, machines: null, status: 'live', suspendedReason: null, viewerCanEnd: false,
}
const view = (patch: Partial<TriggerMachineAccessView>): TriggerMachineAccessView => ({
  author: AUTHOR, pendingCard: null, policy: null, state: 'not_set_up', tickets: [],
  triggerId: '10000000-0000-4000-8000-000000000003', viewerIsAuthor: true, ...patch,
})

test('each state reads as one sentence, and names machines only when the read carries them', () => {
  assert.match(machineAccessStateLine(view({})), /^Tickets this trigger picks up wait for machine access\./)
  assert.match(machineAccessStateLine(view({ policy: { ...POLICY, status: 'preparing' }, state: 'awaiting_confirmation' })),
    /^Ondrej has a card to confirm with their password\./)
  assert.match(machineAccessStateLine(view({ policy: POLICY, state: 'live' })),
    /^Live: anyone who can edit the board starts work on two machines of Ondrej’s, as Ondrej\.$/)
  const named = { ...POLICY, machines: [{ executorId: POLICY.id, label: 'Minis' }], machineCount: 1 }
  assert.match(machineAccessStateLine(view({ policy: named, state: 'live' })), /starts work on Minis, as Ondrej\.$/)
  assert.equal(machineAccessStateLine(view({ policy: { ...POLICY, status: 'suspended', suspendedReason: 'trigger_changed' },
    state: 'suspended' })), 'Paused because the trigger was edited since Ondrej confirmed it. Tickets wait until Ondrej '
    + 'confirms it again.')
  assert.match(machineAccessStateLine(view({
    policy: { ...POLICY, endedByName: 'Ondrej', endedReason: 'author_left_organization', status: 'ended' },
    state: 'ended',
  })), /by Ondrej: its owner is no longer in the organisation\. Tickets wait for machine access until Ondrej sets it/)
  assert.equal(machineAccessLimitsLine(POLICY.limits), '4 hours and $20 a ticket, $60 a day')
})

test('each ticket says where it stands, and its machine only when named', () => {
  const ticket = {
    machineLabel: null, position: null, projectId: POLICY.id, stateReason: null, status: 'active' as const,
    taskId: POLICY.id, title: 'NES-1 Fix it', workId: POLICY.id,
  }
  assert.equal(machineAccessTicketLine(ticket), 'working')
  assert.equal(machineAccessTicketLine({ ...ticket, machineLabel: 'Minis' }), 'working on Minis')
  assert.equal(machineAccessTicketLine({ ...ticket, position: 2, stateReason: 'queued_machines_offline', status: 'queued' }),
    'queued: position 2, the machines are offline')
  assert.equal(machineAccessTicketLine({ ...ticket, stateReason: 'machine_offline', status: 'waiting_machine' }),
    'paused: its machine is offline')
  assert.equal(machineAccessTicketLine({ ...ticket, stateReason: 'machine_access_not_set_up', status: 'waiting_machine' }),
    'waiting for machine access')
})

test('the setup form refuses a machine for what the chosen options cannot give it', () => {
  const minis: StandingPolicyMachineOption = {
    executorId: POLICY.id, label: 'Minis', refusal: null,
    facts: { maxLiveSessionsPerOwner: 3, mergeCommands: [], permissionMode: 'bypassPermissions', rootNames: ['nessie'], turnBudgetUsd: 5 },
  }
  const choices = { allowAnyCommand: false, roots: ['nessie'], ticketUsd: 20 }
  assert.match(machineOptionRefusal(minis, choices) ?? '', /runs any command without asking, which needs “Let the coding/)
  assert.equal(machineOptionRefusal(minis, { ...choices, allowAnyCommand: true }), null)
  assert.match(machineOptionRefusal(minis, { ...choices, allowAnyCommand: true, ticketUsd: 4 }) ?? '',
    /may spend \$5 a turn, more than the \$4 a ticket may spend/)
  assert.equal(machineOptionRefusal(minis, { ...choices, allowAnyCommand: true, roots: ['site'] }),
    'Minis has no coding folder named site.')
  const refused = { ...minis, refusal: { reason: 'offline' as const, sentence: 'Minis is offline. Bring it online first.' } }
  assert.equal(machineOptionRefusal(refused, choices), 'Minis is offline. Bring it online first.')
  assert.deepEqual(sharedCodingRoots([
    { ...minis, facts: { ...minis.facts!, rootNames: ['nessie', 'site'] } },
    { ...minis, facts: { ...minis.facts!, rootNames: ['site', 'docs'] } },
  ]), ['site'])
})

test('a ticket paused for its offline machine says since when (T5)', () => {
  const since = new Date()
  since.setHours(14, 32, 0, 0)
  const clock = since.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const ticket = {
    machineLabel: 'Minis', offlineSince: since.toISOString(), position: null, projectId: POLICY.id,
    stateReason: 'machine_offline' as const, status: 'waiting_machine' as const, taskId: POLICY.id, title: 'NES-1 Fix it',
    workId: POLICY.id,
  }
  assert.equal(machineAccessTicketLine(ticket), `paused: Minis is offline since ${clock}`)
  assert.equal(machineAccessTicketLine({ ...ticket, machineLabel: null }), `paused: its machine is offline since ${clock}`)
})
