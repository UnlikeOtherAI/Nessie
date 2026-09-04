import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  bindAgentEmailApprovalProposal,
  sealedAgentEmailProposalIsLive,
} from './agent-email-approval.js'
import { createConsumedSourceSink } from './disclosure-basis.js'
import type { RunContext } from './types.js'

const ids = {
  agent: '00000000-0000-4000-8000-000000000201',
  channel: '00000000-0000-4000-8000-000000000202',
  mailbox: '00000000-0000-4000-8000-000000000203',
  organization: '00000000-0000-4000-8000-000000000204',
  owner: '00000000-0000-4000-8000-000000000207',
  project: '00000000-0000-4000-8000-000000000205',
  team: '00000000-0000-4000-8000-000000000206',
} as const

const context = (): RunContext => ({
  agent: {
    agentKind: 'shared', effort: 'medium', executionMode: 'inference', id: ids.agent,
    model: null, name: 'Support', ownerUserId: ids.owner, parentAgentId: null, provider: null,
    systemPrompt: null,
  },
  boundAgentIds: [],
  channel: {
    id: ids.channel, organizationId: ids.organization, projectId: ids.project,
    systemChannelType: 'agent_email', teamId: ids.team,
  },
  consumedSources: createConsumedSourceSink(),
  run: { createdAt: new Date(), id: 'run-1', replyPlacement: null, threadId: ids.channel },
  task: { id: 'task-1' },
})

const fakePrisma = (active = true): PrismaClient => ({
  agentMailbox: {
    findFirst: async () => active
      ? { address: 'support@example.test', id: ids.mailbox }
      : null,
  },
  agent: { findFirst: async () => ({ ownerUserId: ids.owner }) },
  emailConversation: { findFirst: async () => null },
  emailMessage: { findFirst: async () => null },
  organizationMember: { count: async () => 1 },
}) as unknown as PrismaClient

test('the server replaces an untrusted hosted-mail proposal before it can be approved', async () => {
  const sealed = await bindAgentEmailApprovalProposal(fakePrisma(), context(), {
    approvalProposal: {
      bcc: ['attacker@example.test'],
      cc: [],
      conversationId: null,
      mailboxId: '00000000-0000-4000-8000-000000000299',
      subject: 'Untrusted target',
      to: ['attacker@example.test'],
    },
    subject: 'Customer update',
    text: 'The reviewed body.',
    to: ['customer@example.test'],
  })

  assert.deepEqual(sealed, {
    approvalProposal: {
      bcc: [],
      cc: [],
      conversationId: null,
      mailboxId: ids.mailbox,
      subject: 'Customer update',
      to: ['customer@example.test'],
    },
    subject: 'Customer update',
    text: 'The reviewed body.',
    to: ['customer@example.test'],
  })
})

test('a sealed hosted-mail proposal dispatches only while its original mailbox is live', async () => {
  const sealed = {
    approvalProposal: {
      bcc: [],
      cc: [],
      conversationId: null,
      mailboxId: ids.mailbox,
      subject: 'Customer update',
      to: ['customer@example.test'],
    },
    subject: 'Customer update',
    text: 'The reviewed body.',
    to: ['customer@example.test'],
  }

  assert.equal(await sealedAgentEmailProposalIsLive(fakePrisma(), context(), sealed), true)
  assert.equal(await sealedAgentEmailProposalIsLive(fakePrisma(false), context(), sealed), false)
})
