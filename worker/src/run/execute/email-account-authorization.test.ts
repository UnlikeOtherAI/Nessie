import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EMAIL_ACCOUNT_DISCONNECT_TOOL_ID,
  parseEmailAccountToolArgs,
} from '@nessie/runtime'
import {
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  parseUserId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'

import { authorizeToolExecution } from './tool-authorization.js'
import { createConsumedSourceSink } from './disclosure-basis.js'
import type { DeepWaterHandoffGuard } from '../deepwater-handoff-guard.js'
import type { RunContext } from './types.js'

const IDS = {
  account: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  agent: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  channel: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  organization: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  project: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  run: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  task: '11111111-1111-4111-8111-111111111111',
  team: '22222222-2222-4222-8222-222222222222',
  user: '33333333-3333-4333-8333-333333333333',
} as const

const actorContext = (): AuthorizedActionContext => ({
  actionContext: {
    effectiveUserId: parseUserId(IDS.user),
    requestId: 'email-account-authorization-test',
  },
  actor: { actorId: IDS.user, actorType: 'user', roles: ['member'] },
  tenant: {
    organizationId: parseOrganizationId(IDS.organization),
    projectId: parseProjectId(IDS.project),
    teamId: parseTeamId(IDS.team),
  },
})

const runContext = (): RunContext => ({
  agent: {
    agentKind: 'personal_assistant',
    effort: 'medium',
    executionMode: 'inference',
    id: IDS.agent,
    model: null,
    name: 'Personal Assistant',
    parentAgentId: null,
    provider: null,
    systemPrompt: null,
  },
  boundAgentIds: [],
  consumedSources: createConsumedSourceSink(),
  channel: {
    id: IDS.channel,
    organizationId: IDS.organization,
    projectId: IDS.project,
    systemChannelType: 'personal_assistant',
    teamId: IDS.team,
  },
  run: { createdAt: new Date(), id: IDS.run, replyPlacement: null, threadId: IDS.channel },
  task: { id: IDS.task },
})

const fakePrisma = () => {
  const approvals: Array<Record<string, unknown>> = []
  const prisma = {
    approvalRequest: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const approval = { ...data, id: `approval-${approvals.length + 1}` }
        approvals.push(approval)
        return { id: approval.id }
      },
      findFirst: async ({ where }: { where: { runId: string; toolCallId: string } }) => {
        const approval = approvals.find(
          (candidate) => candidate['runId'] === where.runId
            && candidate['toolCallId'] === where.toolCallId,
        )
        return approval
          ? {
              argsHash: approval['argsHash'],
              id: approval['id'],
              toolName: approval['toolName'],
            }
          : null
      },
    },
    policyRule: { findMany: async () => [] },
  } as unknown as PrismaClient
  return { approvals, prisma }
}

const hooks = (auditCalls: number[]) => ({
  deepWaterHandoffGuard: {
    suppressBuiltin: async () => false,
  } as unknown as DeepWaterHandoffGuard,
  emitAudit: async () => {
    auditCalls.push(1)
  },
})

const authorizationContext = () => ({
  agentKind: 'personal_assistant' as const,
  allowedToolIds: new Set([EMAIL_ACCOUNT_DISCONNECT_TOOL_ID]),
  maySuspendForApproval: true,
  parentAgentId: null,
  resolvedBuiltinToolIds: new Set([EMAIL_ACCOUNT_DISCONNECT_TOOL_ID]),
  resumeState: {
    actorContext: actorContext(),
    interactive: true,
    messageId: 'message-1',
  },
  structuralGate: async () => ({ outcome: 'approval' as const }),
  toolPolicy: null,
})

test('email lifecycle arguments are strict before any durable authorization work', async () => {
  const state = fakePrisma()
  const auditCalls: number[] = []
  const secret = 'password-that-must-not-be-recorded'

  const decision = await authorizeToolExecution(
    state.prisma,
    actorContext(),
    runContext(),
    EMAIL_ACCOUNT_DISCONNECT_TOOL_ID,
    { accountId: IDS.account, accountKind: 'mailbox', password: secret },
    'call-1',
    authorizationContext(),
    hooks(auditCalls),
  )

  assert.equal(decision.decision, 'deny')
  assert.equal(state.approvals.length, 0)
  assert.equal(auditCalls.length, 1)
  assert.doesNotMatch(JSON.stringify(decision), new RegExp(secret))
})

test('disconnect approval persists canonical arguments and names the target safely', async () => {
  const state = fakePrisma()
  const auditCalls: number[] = []

  const decision = await authorizeToolExecution(
    state.prisma,
    actorContext(),
    runContext(),
    EMAIL_ACCOUNT_DISCONNECT_TOOL_ID,
    { accountId: IDS.account, accountKind: 'mailbox' },
    'call-2',
    authorizationContext(),
    hooks(auditCalls),
  )

  assert.equal(decision.decision, 'suspend')
  if (decision.decision !== 'suspend') return
  assert.deepEqual(decision.args, { accountId: IDS.account, accountKind: 'mailbox' })
  assert.match(decision.approval.notice, /Disconnect IMAP\/SMTP mailbox …aaaaaaaa/)
  assert.equal(state.approvals.length, 1)
  const approval = state.approvals[0]!
  assert.deepEqual((approval['resumeState'] as { args: unknown }).args, {
    accountId: IDS.account,
    accountKind: 'mailbox',
  })
  assert.deepEqual(approval['context'], {
    approvalActionType: null,
    audience: 'Its connection credentials will be removed',
    boundaryReason: null,
    headline: 'Disconnect IMAP/SMTP mailbox …aaaaaaaa',
    inputSummary: '{"accountId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","accountKind":"mailbox"}',
    policyRuleId: null,
    toolName: EMAIL_ACCOUNT_DISCONNECT_TOOL_ID,
  })
  assert.equal(auditCalls.length, 1)
})

test('connect defaults scope while rejecting unrecognised credential fields', () => {
  assert.deepEqual(parseEmailAccountToolArgs('email_account_connect', {}), { scope: 'user' })
  assert.throws(
    () => parseEmailAccountToolArgs('email_account_connect', { oauthCode: 'secret' }),
  )
})

test('an approval cannot be reused for different arguments under one tool-call id', async () => {
  const state = fakePrisma()
  const auditCalls: number[] = []
  const authorize = (accountId: string) => authorizeToolExecution(
    state.prisma,
    actorContext(),
    runContext(),
    EMAIL_ACCOUNT_DISCONNECT_TOOL_ID,
    { accountId, accountKind: 'mailbox' },
    'reused-call',
    authorizationContext(),
    hooks(auditCalls),
  )

  assert.equal((await authorize(IDS.account)).decision, 'suspend')
  await assert.rejects(() => authorize(IDS.agent), /different action or arguments/)
  assert.equal(state.approvals.length, 1)
})
