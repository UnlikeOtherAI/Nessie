import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { createConsumedSourceSink, emailMailboxScope } from '../src/run/execute/disclosure-basis.js'
import {
  buildEmailSendApprovalHook,
  evaluateEmailSendGate,
} from '../src/run/execute/email-send-gate.js'
import type { RunContext } from '../src/run/execute/types.js'

const ORG = '00000000-0000-4000-8000-000000000001'
const PROJECT = '00000000-0000-4000-8000-000000000002'
const TEAM = '00000000-0000-4000-8000-000000000003'
const CHANNEL = '00000000-0000-4000-8000-000000000004'
const AGENT = '00000000-0000-4000-8000-000000000005'
const MAILBOX = '00000000-0000-4000-8000-000000000006'
const OWNER = '00000000-0000-4000-8000-000000000007'
const CONVERSATION = '00000000-0000-4000-8000-000000000008'

type Fake = {
  sendPolicy?: 'approval' | 'auto_reply' | 'auto'
  mailbox?: boolean
  sentInLastHour?: number
  liveOwner?: boolean
}

/**
 * Every delegate the gate touches needs a stub here: the client is cast, so a
 * model this fake forgets is `undefined` at call time rather than a type error.
 */
const makePrisma = (fake: Fake = {}): PrismaClient =>
  ({
    agentMailbox: {
      findFirst: async () =>
        fake.mailbox === false
          ? null
          : { id: MAILBOX, sendPolicy: fake.sendPolicy ?? 'approval' },
    },
    emailConversation: { findUnique: async () => ({ subject: 'Invoice question' }) },
    emailMessage: {
      count: async () => fake.sentInLastHour ?? 0,
      findFirst: async () => ({
        ccAddresses: ['accounts@example.com'],
        fromAddress: 'petra@example.com',
        replyToAddress: null,
        toAddresses: ['support@nessie.works'],
      }),
    },
    organizationMember: { count: async () => (fake.liveOwner === false ? 0 : 1) },
  }) as unknown as PrismaClient

const makeContext = (overrides: Partial<RunContext> = {}): RunContext =>
  ({
    agent: {
      agentKind: 'shared',
      effort: 'medium',
      executionMode: 'inference',
      id: AGENT,
      name: 'Support',
      ownerUserId: OWNER,
      parentAgentId: null,
      provider: 'openai',
      model: 'gpt-4o',
      systemPrompt: null,
      runLimits: null,
      visibility: 'team',
    },
    boundAgentIds: [AGENT],
    channel: {
      id: CHANNEL,
      organizationId: ORG,
      projectId: PROJECT,
      systemChannelType: 'agent_email',
      teamId: TEAM,
    },
    consumedSources: createConsumedSourceSink(),
    emailConversationId: CONVERSATION,
    emailMailboxId: MAILBOX,
    run: {
      createdAt: new Date(),
      id: 'run-1',
      principalUserId: null,
      replyPlacement: null,
      threadId: 'thread-1',
    },
    task: { id: 'task-1' },
    ...overrides,
  }) as unknown as RunContext

test('the default policy parks every send for a human', async () => {
  const decision = await evaluateEmailSendGate(makePrisma(), makeContext(), {
    args: { text: 'hi' },
    interactive: true,
  })
  assert.equal(decision.required, true)
  assert.equal(decision.reason, 'policy_approval')
})

test('under auto_reply a reply that read only its own mailbox sends without asking', async () => {
  const context = makeContext()
  // Exactly what an email run legitimately consumes: its own correspondence.
  context.consumedSources.add(emailMailboxScope(MAILBOX))
  const decision = await evaluateEmailSendGate(
    makePrisma({ sendPolicy: 'auto_reply' }),
    context,
    { args: { text: 'on it' }, interactive: false },
  )
  assert.equal(
    decision.required,
    false,
    'the mailbox scope is implied here — otherwise every reply would deadlock behind approval',
  )
})

test('an unattended run may never open a new conversation unasked', async () => {
  const decision = await evaluateEmailSendGate(
    makePrisma({ sendPolicy: 'auto_reply' }),
    makeContext(),
    { args: { subject: 'Hello', text: 'cold outreach', to: ['stranger@example.com'] }, interactive: false },
  )
  assert.equal(decision.required, true)
  assert.equal(decision.reason, 'unattended_new_conversation')
})

test('an interactive person can start a new conversation under auto_reply', async () => {
  const context = makeContext()
  context.consumedSources.add(emailMailboxScope(MAILBOX))
  const decision = await evaluateEmailSendGate(
    makePrisma({ sendPolicy: 'auto_reply' }),
    context,
    { args: { subject: 'Hello', text: 'hi', to: ['petra@example.com'] }, interactive: true },
  )
  assert.equal(decision.required, false)
})

test('a privileged source read beyond the mailbox forces approval even under auto', async () => {
  const context = makeContext()
  context.consumedSources.add(emailMailboxScope(MAILBOX))
  // A private knowledge space, another channel's messages, a narrower memory —
  // anything whose audience the recipient is not in.
  context.consumedSources.add({ scopeId: 'space-private', scopeType: 'user' })
  const decision = await evaluateEmailSendGate(makePrisma({ sendPolicy: 'auto' }), context, {
    args: { text: 'here is what I found' },
    interactive: true,
  })
  assert.equal(decision.required, true)
  assert.equal(decision.reason, 'external_disclosure')
  assert.deepEqual(
    decision.externalSources.map((scope) => `${scope.scopeType}:${scope.scopeId}`),
    ['user:space-private'],
    'the approver is told exactly what would leave the team',
  )
})

test('reading the run’s own channel and org is never an external disclosure', async () => {
  const context = makeContext()
  context.consumedSources.add({ scopeId: CHANNEL, scopeType: 'channel' })
  context.consumedSources.add({ scopeId: ORG, scopeType: 'organization' })
  context.consumedSources.add({ scopeId: AGENT, scopeType: 'agent' })
  const decision = await evaluateEmailSendGate(makePrisma({ sendPolicy: 'auto' }), context, {
    args: { text: 'ok' },
    interactive: true,
  })
  assert.equal(decision.required, false)
})

test('the hourly cap parks the overflow instead of dropping or blasting it', async () => {
  const context = makeContext()
  context.consumedSources.add(emailMailboxScope(MAILBOX))
  const decision = await evaluateEmailSendGate(
    makePrisma({ sendPolicy: 'auto', sentInLastHour: 30 }),
    context,
    { args: { text: 'again' }, interactive: true },
  )
  assert.equal(decision.required, true)
  assert.equal(decision.reason, 'rate_limited')
})

test('an agent with no mailbox is not gated — the tool itself refuses', async () => {
  const decision = await evaluateEmailSendGate(makePrisma({ mailbox: false }), makeContext(), {
    args: { text: 'hi' },
    interactive: true,
  })
  assert.equal(decision.required, false)
})

test('the hook ignores every tool but email_send', async () => {
  const hook = buildEmailSendApprovalHook(makePrisma(), makeContext(), true)
  // null, not `{escalate:false}`: a null answer means this family does not own
  // the tool, so authorization falls through to the standing-consent path.
  assert.equal(await hook({ args: {}, toolName: 'kb_search' }), null)
  const owned = await hook({ args: { text: 'x' }, toolName: 'email_send' })
  assert.equal(owned?.escalate, true)
})

test('a send that needs no approval is owned but not escalated', async () => {
  const context = makeContext()
  context.consumedSources.add(emailMailboxScope(MAILBOX))
  const hook = buildEmailSendApprovalHook(
    makePrisma({ sendPolicy: 'auto_reply' }),
    context,
    false,
  )
  const decision = await hook({ args: { text: 'on it' }, toolName: 'email_send' })
  assert.deepEqual(
    decision,
    { escalate: false },
    'owning the decision is what keeps email_send off the send-as-you consent path',
  )
})

test('the approval pins the agent’s live steward and records why it asked', async () => {
  const hook = buildEmailSendApprovalHook(makePrisma(), makeContext(), true)
  const decision = await hook({ args: { text: 'replying' }, toolName: 'email_send' })
  assert.equal(decision?.escalate, true)
  assert.equal(decision?.requiredApproverUserId, OWNER)
  // The reason reaches the approval card: "approval required" alone does not
  // tell somebody whether to read the message carefully or just press send.
  assert.match(decision?.reason ?? '', /approve every message/i)
})

test('the approval context carries no addresses — only the conversation and scopes', async () => {
  // The approval row is readable through the approvals surface by an org
  // owner. Recipients belong to the owner-gated draft route, which resolves
  // them at read time; putting them here would widen them to every owner.
  const context = makeContext()
  context.consumedSources.add(emailMailboxScope(MAILBOX))
  context.consumedSources.add({ scopeId: 'space-private', scopeType: 'user' })
  const hook = buildEmailSendApprovalHook(makePrisma({ sendPolicy: 'auto' }), context, true)
  const decision = await hook({ args: { text: 'x' }, toolName: 'email_send' })

  const extra = (decision?.contextExtra ?? {}) as Record<string, unknown>
  assert.deepEqual(Object.keys(extra).sort(), ['emailConversationId', 'externalDisclosureSources'])
  assert.deepEqual(extra.externalDisclosureSources, ['user:space-private'])
  assert.equal(
    JSON.stringify(extra).includes('@'),
    false,
    'no address may reach the approval row',
  )
})

test('a deactivated steward falls back to the owner role rather than being unanswerable', async () => {
  const hook = buildEmailSendApprovalHook(makePrisma({ liveOwner: false }), makeContext(), true)
  const decision = await hook({ args: { text: 'x' }, toolName: 'email_send' })
  assert.equal(decision?.requiredApproverUserId, null)
})
