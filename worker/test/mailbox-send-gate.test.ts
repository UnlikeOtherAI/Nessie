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
    organizationMember: { count: async () => (options.liveApprover === false ? 0 : 1) },
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
    { connectionId: null, effectiveUserId: OWNER },
  )
  assert.equal(decision?.requiredApproverUserId, OWNER)
  assert.match(decision?.reason ?? '', /personal mailbox/)
  assert.match(decision?.reason ?? '', /petra@example\.com/)
})

test('a shared mailbox pins the approval to whoever connected it', async () => {
  const decision = await evaluateMailboxSendGate(
    makePrisma([shared]),
    makeContext(),
    { connectionId: null, effectiveUserId: null },
  )
  assert.equal(decision?.requiredApproverUserId, INSTALLER)
  assert.match(decision?.reason ?? '', /shared team mailbox/)
})

test('a departed approver leaves the request unpinned rather than unanswerable', async () => {
  const decision = await evaluateMailboxSendGate(
    makePrisma([shared], { liveApprover: false }),
    makeContext(),
    { connectionId: null, effectiveUserId: null },
  )
  assert.equal(
    decision?.requiredApproverUserId,
    null,
    'falling back to ordinary approval visibility is the safe direction',
  )
})

test('reading its own mailbox is not reported as a disclosure', async () => {
  const context = makeContext()
  // Exactly what answering the correspondence legitimately consumes.
  context.consumedSources.add({ scopeId: TEAM, scopeType: 'team' })
  const decision = await evaluateMailboxSendGate(
    makePrisma([shared]),
    context,
    { connectionId: null, effectiveUserId: null },
  )
  assert.doesNotMatch(decision?.reason ?? '', /cannot reach/)
})

test('material the recipient cannot reach is named on the approval', async () => {
  const context = makeContext()
  context.consumedSources.add({ scopeId: 'someone-else', scopeType: 'user' })
  const decision = await evaluateMailboxSendGate(
    makePrisma([shared]),
    context,
    { connectionId: null, effectiveUserId: null },
  )
  assert.match(decision?.reason ?? '', /cannot reach: user:someone-else/)
})

test('an unresolvable mailbox is left to the tool to refuse, not to a person to approve', async () => {
  const ambiguous = await evaluateMailboxSendGate(
    makePrisma([personal, shared]),
    makeContext(),
    { connectionId: null, effectiveUserId: OWNER },
  )
  assert.equal(ambiguous, null, 'two reachable mailboxes: the tool names the ambiguity')

  const none = await evaluateMailboxSendGate(
    makePrisma([]),
    makeContext(),
    { connectionId: null, effectiveUserId: OWNER },
  )
  assert.equal(none, null)
})

test('the hook claims mailbox_send and nothing else', async () => {
  const hook = buildMailboxSendApprovalHook(makePrisma([shared]), makeContext(), null)
  assert.equal(await hook({ args: {}, toolName: 'email_send' }), null)
  assert.equal(await hook({ args: {}, toolName: 'gmail_draft_send' }), null)

  const claimed = await hook({ args: { to: ['a@b.test'] }, toolName: 'mailbox_send' })
  assert.equal(claimed?.escalate, true, 'every send from a connected mailbox is asked')
  assert.equal(
    (claimed?.contextExtra as { mailboxConnectionId?: unknown })?.mailboxConnectionId,
    null,
  )
  assert.equal(
    Object.values(claimed?.contextExtra ?? {}).some(
      (value) => typeof value === 'string' && value.includes('@'),
    ),
    false,
    'the approval row carries no address',
  )
})
