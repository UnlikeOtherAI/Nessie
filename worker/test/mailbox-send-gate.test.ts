import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { createConsumedSourceSink } from '../src/run/execute/disclosure-basis.js'
import {
  buildMailboxSendApprovalHook,
  evaluateMailboxSendGate,
} from '../src/run/execute/mailbox-send-gate.js'
import type { RunContext } from '../src/run/execute/types.js'

const ORG = '00000000-0000-4000-8000-000000000101'
const PROJECT = '00000000-0000-4000-8000-000000000102'
const TEAM = '00000000-0000-4000-8000-000000000103'
const CHANNEL = '00000000-0000-4000-8000-000000000104'
const AGENT = '00000000-0000-4000-8000-000000000105'
const OWNER = '00000000-0000-4000-8000-000000000106'
const INSTALLER = '00000000-0000-4000-8000-000000000107'
const PERSONAL = '00000000-0000-4000-8000-000000000108'
const SHARED = '00000000-0000-4000-8000-000000000109'

type FakeConnection = {
  id: string
  label: string
  address: string
  ownerUserId: string | null
  teamId: string | null
  createdByUserId: string | null
}

const personal: FakeConnection = {
  address: 'petra@example.com',
  createdByUserId: OWNER,
  id: PERSONAL,
  label: 'My mail',
  ownerUserId: OWNER,
  teamId: null,
}

const shared: FakeConnection = {
  address: 'support@example.com',
  createdByUserId: INSTALLER,
  id: SHARED,
  label: 'Support',
  ownerUserId: null,
  teamId: TEAM,
}

const unassignedShared: FakeConnection = {
  ...shared,
  createdByUserId: null,
  id: '00000000-0000-4000-8000-000000000110',
}

/**
 * The rows this fake returns are shaped exactly as `listReachableMailboxes`
 * selects them, and the predicate that produces them is covered against the
 * real database in `test/db/mailbox-connection-access.test.ts`. What is under
 * test here is the part above that query: which scopes count as a disclosure,
 * and who the approval is pinned to.
 */
const makePrisma = (
  connections: FakeConnection[],
  options: { liveApprover?: boolean } = {},
): PrismaClient =>
  ({
    mailboxConnection: { findMany: async () => connections },
    organizationMember: {
      findFirst: async ({ where }: { where: { userId?: string } }) =>
        options.liveApprover === false ? null : { userId: where.userId },
    },
  }) as unknown as PrismaClient

const makeContext = (): RunContext =>
  ({
    agent: { agentKind: 'shared', id: AGENT, name: 'Support', ownerUserId: OWNER },
    boundAgentIds: [AGENT],
    channel: {
      id: CHANNEL,
      organizationId: ORG,
      projectId: PROJECT,
      systemChannelType: null,
      teamId: TEAM,
    },
    consumedSources: createConsumedSourceSink(),
    run: { id: 'run-1', threadId: 'thread-1' },
    task: { id: 'task-1' },
  }) as unknown as RunContext

test('a personal mailbox pins the approval to its owner', async () => {
  const decision = await evaluateMailboxSendGate(
    makePrisma([personal]),
    makeContext(),
    { connectionId: PERSONAL, effectiveUserId: OWNER },
  )
  assert.equal(decision.outcome, 'approval')
  if (decision.outcome !== 'approval') return
  assert.equal(decision.requiredApproverUserId, OWNER)
  assert.match(decision.reason, /personal connected mailbox/)
  assert.doesNotMatch(decision.reason, /@/)
})

test('a shared mailbox pins the approval to whoever connected it', async () => {
  const decision = await evaluateMailboxSendGate(
    makePrisma([shared]),
    makeContext(),
    { connectionId: SHARED, effectiveUserId: null },
  )
  assert.equal(decision.outcome, 'approval')
  if (decision.outcome !== 'approval') return
  assert.equal(decision.requiredApproverUserId, INSTALLER)
  assert.match(decision.reason, /shared team mailbox/)
})

test('an inactive shared-mailbox installer denies without an unpinned approval', async () => {
  const decision = await evaluateMailboxSendGate(
    makePrisma([shared], { liveApprover: false }),
    makeContext(),
    { connectionId: SHARED, effectiveUserId: null },
  )
  assert.deepEqual(decision, {
    message: 'The person assigned to approve shared mailbox sends is no longer active. '
      + 'An owner or admin must reconnect it under an active approver before it can send.',
    outcome: 'deny',
    reason: 'mailbox_approver_unavailable',
  })
})

test('an inactive personal-mailbox owner denies without a fallback approver', async () => {
  const decision = await evaluateMailboxSendGate(
    makePrisma([personal], { liveApprover: false }),
    makeContext(),
    { connectionId: PERSONAL, effectiveUserId: OWNER },
  )
  assert.equal(decision.outcome, 'deny')
  if (decision.outcome !== 'deny') return
  assert.match(decision.message, /personal mailbox owner is no longer active/i)
  assert.equal('requiredApproverUserId' in decision, false)
})

test('an unassigned shared mailbox denies and requires reconnecting it under an approver', async () => {
  const decision = await evaluateMailboxSendGate(
    makePrisma([unassignedShared]),
    makeContext(),
    { connectionId: unassignedShared.id, effectiveUserId: null },
  )
  assert.deepEqual(decision, {
    message: 'This shared mailbox has no assigned approver. An owner or admin must reconnect '
      + 'it under an active approver before it can send.',
    outcome: 'deny',
    reason: 'mailbox_approver_unavailable',
  })
})

test('reading its own mailbox is not reported as a disclosure', async () => {
  const context = makeContext()
  // Exactly what answering the correspondence legitimately consumes.
  context.consumedSources.add({ scopeId: TEAM, scopeType: 'team' })
  const decision = await evaluateMailboxSendGate(
    makePrisma([shared]),
    context,
    { connectionId: SHARED, effectiveUserId: null },
  )
  assert.equal(decision.outcome, 'approval')
  if (decision.outcome !== 'approval') return
  assert.doesNotMatch(decision.reason, /cannot reach/)
})

test('material the recipient cannot reach is named on the approval', async () => {
  const context = makeContext()
  context.consumedSources.add({ scopeId: 'someone-else', scopeType: 'user' })
  const decision = await evaluateMailboxSendGate(
    makePrisma([shared]),
    context,
    { connectionId: SHARED, effectiveUserId: null },
  )
  assert.equal(decision.outcome, 'approval')
  if (decision.outcome !== 'approval') return
  assert.match(decision.reason, /cannot reach: user:someone-else/)
})

test('a missing selected mailbox denies rather than asking someone to approve another one', async () => {
  const unavailable = await evaluateMailboxSendGate(
    makePrisma([personal, shared]),
    makeContext(),
    { connectionId: '00000000-0000-4000-8000-000000000111', effectiveUserId: OWNER },
  )
  assert.equal(unavailable.outcome, 'deny')
  assert.equal(unavailable.reason, 'mailbox_unavailable')
})

test('the hook claims mailbox_send and nothing else', async () => {
  const hook = buildMailboxSendApprovalHook(makePrisma([shared]), makeContext(), null)
  assert.equal(await hook({ args: {}, toolName: 'email_send' }), null)
  assert.equal(await hook({ args: {}, toolName: 'gmail_draft_send' }), null)

  const claimed = await hook({
    args: { connectionId: SHARED, to: ['a@b.test'] },
    toolName: 'mailbox_send',
  })
  assert.equal(claimed?.outcome, 'approval', 'every send from a connected mailbox is asked')
  assert.equal(
    (claimed?.contextExtra as { mailboxConnectionId?: unknown })?.mailboxConnectionId,
    SHARED,
  )
  assert.equal(
    Object.values(claimed?.contextExtra ?? {}).some(
      (value) => typeof value === 'string' && value.includes('@'),
    ),
    false,
    'the approval row carries no address',
  )
  assert.doesNotMatch(claimed?.reason ?? '', /@/)
})
