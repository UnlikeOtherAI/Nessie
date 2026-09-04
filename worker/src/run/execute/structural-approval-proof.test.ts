import assert from 'node:assert/strict'
import test from 'node:test'

import { EMAIL_SEND_TOOL_ID, MAILBOX_SEND_TOOL_ID } from '@nessie/runtime'
import {
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  parseUserId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'

import { authorizeToolExecution } from './tool-authorization.js'
import { createToolApprovalRequest } from './tool-approval.js'
import { createConsumedSourceSink } from './disclosure-basis.js'
import { hashJsonValue } from '../tool-util.js'
import type { DeepWaterHandoffGuard } from '../deepwater-handoff-guard.js'
import type { RunContext } from './types.js'

const ids = {
  agent: '11111111-1111-4111-8111-111111111111',
  channel: '22222222-2222-4222-8222-222222222222',
  organization: '33333333-3333-4333-8333-333333333333',
  parentRun: '44444444-4444-4444-8444-444444444444',
  project: '55555555-5555-4555-8555-555555555555',
  run: '66666666-6666-4666-8666-666666666666',
  task: '77777777-7777-4777-8777-777777777777',
  team: '88888888-8888-4888-8888-888888888888',
  user: '99999999-9999-4999-8999-999999999999',
} as const

const args = {
  connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  subject: 'Status',
  text: 'All clear.',
  to: ['ops@example.test'],
}

const context = (): RunContext => ({
  agent: {
    agentKind: 'personal_assistant', effort: 'medium', executionMode: 'inference', id: ids.agent,
    model: null, name: 'PA', parentAgentId: null, provider: null, systemPrompt: null,
  },
  boundAgentIds: [],
  channel: {
    id: ids.channel, organizationId: ids.organization, projectId: ids.project,
    systemChannelType: null, teamId: ids.team,
  },
  consumedSources: createConsumedSourceSink(),
  run: { createdAt: new Date(), id: ids.run, replyPlacement: null, threadId: ids.channel },
  task: { id: ids.task },
})

const actor = (proof = 'approved-proof'): AuthorizedActionContext => ({
  actionContext: { effectiveUserId: parseUserId(ids.user), requestId: 'structural-proof-test' },
  actor: { actorId: ids.user, actorType: 'user', roles: ['member'] },
  approval: { approvalId: 'approval-1', approvalProof: proof },
  tenant: {
    organizationId: parseOrganizationId(ids.organization),
    projectId: parseProjectId(ids.project), teamId: parseTeamId(ids.team),
  },
})

const authorization = () => ({
  agentKind: 'personal_assistant' as const,
  allowedToolIds: new Set([MAILBOX_SEND_TOOL_ID]),
  maySuspendForApproval: false,
  parentAgentId: null,
  resolvedBuiltinToolIds: new Set([MAILBOX_SEND_TOOL_ID]),
  structuralGate: async () => ({ outcome: 'approval' as const }),
  toolPolicy: { [MAILBOX_SEND_TOOL_ID]: true },
})

const hooks = {
  deepWaterHandoffGuard: { suppressBuiltin: async () => false } as unknown as DeepWaterHandoffGuard,
  emitAudit: async () => undefined,
}

const fakePrisma = (approvedArgs = args, claimSucceeds = true) => {
  const approval = {
    action: 'tool.invoke',
    argsHash: hashJsonValue(approvedArgs),
    continuationToken: 'approved-proof',
    id: 'approval-1',
    organizationId: ids.organization,
    proofConsumedAt: null as Date | null,
    runId: ids.parentRun,
    status: 'approved',
    toolName: MAILBOX_SEND_TOOL_ID,
  }
  return {
    approval,
    prisma: {
      approvalRequest: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          Object.entries(where).every(([key, value]) => approval[key as keyof typeof approval] === value)
            ? { id: approval.id, runId: approval.runId }
            : null,
        updateMany: async ({ where }: { where: Record<string, unknown> }) => {
          if (
            !claimSucceeds
            || !Object.entries(where).every(([key, value]) => approval[key as keyof typeof approval] === value)
          ) {
            return { count: 0 }
          }
          approval.proofConsumedAt = new Date()
          return { count: 1 }
        },
      },
      policyRule: { findMany: async () => [] },
      run: { findUnique: async () => ({ continuationOfRunId: ids.parentRun }) },
    } as unknown as PrismaClient,
  }
}

test('a structural approval proof verifies canonical args and is consumed once at dispatch', async () => {
  const valid = fakePrisma()
  const first = await authorizeToolExecution(
    valid.prisma, actor(), context(), MAILBOX_SEND_TOOL_ID, args, 'call-1', authorization(), hooks,
  )
  assert.equal(first.decision, 'allow')
  assert.ok(valid.approval.proofConsumedAt instanceof Date)

  const replay = await authorizeToolExecution(
    valid.prisma, actor(), context(), MAILBOX_SEND_TOOL_ID, args, 'call-1', authorization(), hooks,
  )
  assert.equal(replay.decision, 'deny')

  const invalid = fakePrisma()
  const invalidProof = await authorizeToolExecution(
    invalid.prisma, actor('not-approved'), context(), MAILBOX_SEND_TOOL_ID, args, 'call-2', authorization(), hooks,
  )
  assert.equal(invalidProof.decision, 'deny')
  assert.equal(invalid.approval.proofConsumedAt, null)

  const mismatched = fakePrisma()
  const mismatch = await authorizeToolExecution(
    mismatched.prisma, actor(), context(), MAILBOX_SEND_TOOL_ID,
    { ...args, subject: 'Different action' }, 'call-3', authorization(), hooks,
  )
  assert.equal(mismatch.decision, 'deny')
  assert.equal(mismatched.approval.proofConsumedAt, null)

  const claimRace = fakePrisma(args, false)
  const auditReasons: string[] = []
  const raced = await authorizeToolExecution(
    claimRace.prisma, actor(), context(), MAILBOX_SEND_TOOL_ID, args, 'call-4', authorization(), {
      ...hooks,
      emitAudit: async (_actor, input) => { auditReasons.push(input.reason ?? '') },
    },
  )
  assert.equal(raced.decision, 'deny')
  assert.deepEqual(auditReasons, ['approval_required'])
})

test('mailbox_send rejects secret-shaped undeclared input before approval persistence', async () => {
  const state = fakePrisma()
  const secret = 'do-not-persist-this-password'
  const decision = await authorizeToolExecution(
    state.prisma, actor(), context(), MAILBOX_SEND_TOOL_ID,
    { ...args, password: secret }, 'call-5', authorization(), hooks,
  )
  assert.equal(decision.decision, 'deny')
  assert.equal(state.approval.proofConsumedAt, null)
  assert.doesNotMatch(JSON.stringify(decision), new RegExp(secret))
})

test('mailbox approval context is content-free while frozen resume args stay exact', async () => {
  const storedRows: Array<Record<string, unknown>> = []
  const prisma = {
    approvalRequest: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        storedRows.push(data)
        return { id: 'approval-content-free', requiredApproverUserId: ids.user }
      },
      findFirst: async () => null,
    },
  } as unknown as PrismaClient
  const privateArgs = {
    ...args,
    subject: 'Private renewal terms',
    text: 'Please send the private body to ops@example.test.',
    to: ['ops@example.test'],
  }

  await createToolApprovalRequest(prisma, {
    actorContext: actor('no-proof'),
    args: privateArgs,
    context: context(),
    interactive: true,
    messageId: 'message-content-free',
    requiredApproverUserId: ids.user,
    toolCallId: 'call-content-free',
    toolName: MAILBOX_SEND_TOOL_ID,
  })

  const stored = storedRows[0]
  assert.ok(stored)
  const persistedContext = JSON.stringify(stored.context)
  assert.doesNotMatch(persistedContext, /ops@example\.test|Private renewal|private body/)
  assert.equal(
    (stored.context as { headline?: string }).headline,
    'Send an email from a connected mailbox',
  )
  assert.deepEqual((stored.resumeState as { args: unknown }).args, privateArgs)
  assert.equal(stored.argsHash, hashJsonValue(privateArgs))
})

test('hosted-mail approval context and reason are content-free while its sealed proposal stays exact', async () => {
  const storedRows: Array<Record<string, unknown>> = []
  const prisma = {
    approvalRequest: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        storedRows.push(data)
        return { id: 'approval-hosted-content-free', requiredApproverUserId: ids.user }
      },
      findFirst: async () => null,
    },
  } as unknown as PrismaClient
  const privateArgs = {
    approvalProposal: {
      bcc: ['audit@example.test'],
      cc: [],
      conversationId: null,
      mailboxId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      subject: 'Private renewal terms',
      to: ['ops@example.test'],
    },
    subject: 'Private renewal terms',
    text: 'Please send the private body to ops@example.test.',
    to: ['ops@example.test'],
  }

  await createToolApprovalRequest(prisma, {
    actorContext: actor('no-proof'),
    args: privateArgs,
    context: context(),
    interactive: true,
    messageId: 'message-hosted-content-free',
    requiredApproverUserId: ids.user,
    toolCallId: 'call-hosted-content-free',
    toolName: EMAIL_SEND_TOOL_ID,
  })

  const stored = storedRows[0]
  assert.ok(stored)
  assert.doesNotMatch(
    JSON.stringify({ context: stored.context, reason: stored.reason }),
    /ops@example\.test|Private renewal|private body|audit@example/,
  )
  assert.equal((stored.context as { headline?: string }).headline, 'Send an email from the agent mailbox')
  assert.equal(stored.reason, 'Review the email before deciding whether to send it.')
  assert.deepEqual((stored.resumeState as { args: unknown }).args, privateArgs)
  assert.equal(stored.argsHash, hashJsonValue(privateArgs))
})

test('a structural mailbox denial reaches the model without creating an approval', async () => {
  const state = fakePrisma()
  const auditReasons: string[] = []
  const decision = await authorizeToolExecution(
    state.prisma,
    actor('no-proof'),
    context(),
    MAILBOX_SEND_TOOL_ID,
    args,
    'call-6',
    {
      ...authorization(),
      maySuspendForApproval: true,
      resumeState: { actorContext: actor('no-proof'), interactive: true, messageId: 'message-1' },
      structuralGate: async () => ({
        message: 'Reconnect this mailbox under an active approver before it can send.',
        outcome: 'deny' as const,
        reason: 'mailbox_approver_unavailable',
      }),
    },
    {
      ...hooks,
      emitAudit: async (_actor, input) => { auditReasons.push(input.reason ?? '') },
    },
  )
  assert.equal(decision.decision, 'deny')
  if (decision.decision !== 'deny') return
  assert.match(decision.result.output, /Reconnect this mailbox under an active approver/)
  assert.deepEqual(auditReasons, ['mailbox_approver_unavailable'])
})
