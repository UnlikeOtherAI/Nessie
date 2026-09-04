import assert from 'node:assert/strict'
import test from 'node:test'

import { GMAIL_DRAFT_SEND_TOOL_ID } from '@nessie/runtime'
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

const ids = {
  agent: '11111111-1111-4111-8111-111111111111',
  channel: '22222222-2222-4222-8222-222222222222',
  draft: '33333333-3333-4333-8333-333333333333',
  organization: '44444444-4444-4444-8444-444444444444',
  parentRun: '55555555-5555-4555-8555-555555555555',
  project: '66666666-6666-4666-8666-666666666666',
  run: '77777777-7777-4777-8777-777777777777',
  task: '88888888-8888-4888-8888-888888888888',
  team: '99999999-9999-4999-8999-999999999999',
  user: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
} as const

const fingerprint = (char: string): string => char.repeat(64)
const toolArgs = { draftId: ids.draft }

const runContext = (): RunContext => ({
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

const actor = (approved = false): AuthorizedActionContext => ({
  actionContext: { effectiveUserId: parseUserId(ids.user), requestId: 'gmail-draft-approval-test' },
  actor: { actorId: ids.user, actorType: 'user', roles: ['member'] },
  ...(approved ? { approval: { approvalId: 'approval-1', approvalProof: 'approved-proof' } } : {}),
  tenant: {
    organizationId: parseOrganizationId(ids.organization),
    projectId: parseProjectId(ids.project), teamId: parseTeamId(ids.team),
  },
})

const authorization = (maySuspendForApproval: boolean) => ({
  agentKind: 'personal_assistant' as const,
  allowedToolIds: new Set([GMAIL_DRAFT_SEND_TOOL_ID]),
  maySuspendForApproval,
  parentAgentId: null,
  resolvedBuiltinToolIds: new Set([GMAIL_DRAFT_SEND_TOOL_ID]),
  resumeState: {
    actorContext: actor(), interactive: true, messageId: 'message-1',
  },
  structuralGate: async () => ({ escalate: true }),
  toolPolicy: { [GMAIL_DRAFT_SEND_TOOL_ID]: true },
})

const hooks = (audits: Array<Record<string, unknown>>) => ({
  deepWaterHandoffGuard: { suppressBuiltin: async () => false } as unknown as DeepWaterHandoffGuard,
  emitAudit: async (_actor: AuthorizedActionContext, input: { metadata?: Record<string, unknown>; outcome: string }) => {
    audits.push({ ...(input.metadata ?? {}), outcome: input.outcome })
  },
})

const fakePrisma = (state: { contentFingerprint: string }, claimSucceeds = true) => {
  const approvals: Array<Record<string, unknown>> = []
  const prisma = {
    approvalRequest: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const approval = { ...data, id: 'approval-1' }
        approvals.push(approval)
        return { id: approval.id }
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const candidate = approvals[0]
        if (!candidate) return null
        return Object.entries(where).every(([key, value]) => candidate[key] === value)
          ? { id: candidate.id, runId: candidate.runId }
          : null
      },
      updateMany: async ({ where }: { where: Record<string, unknown> }) => {
        const candidate = approvals[0]
        if (!claimSucceeds || !candidate || !Object.entries(where).every(([key, value]) => candidate[key] === value)) {
          return { count: 0 }
        }
        candidate.proofConsumedAt = new Date()
        return { count: 1 }
      },
    },
    gmailDraftAction: { findFirst: async () => ({ contentFingerprint: state.contentFingerprint }) },
    policyRule: { findMany: async () => [] },
    run: { findUnique: async () => ({ continuationOfRunId: ids.parentRun }) },
  } as unknown as PrismaClient
  return { approvals, prisma }
}

const approve = (approval: Record<string, unknown>) => {
  Object.assign(approval, {
    action: 'tool.invoke',
    continuationToken: 'approved-proof',
    organizationId: ids.organization,
    proofConsumedAt: null,
    runId: ids.parentRun,
    status: 'approved',
    toolName: GMAIL_DRAFT_SEND_TOOL_ID,
  })
}

test('a Gmail approval proof is invalidated when recipients or body change after approval', async () => {
  const state = { contentFingerprint: fingerprint('a') }
  const fake = fakePrisma(state)
  const audits: Array<Record<string, unknown>> = []
  const suspended = await authorizeToolExecution(
    fake.prisma, actor(), runContext(), GMAIL_DRAFT_SEND_TOOL_ID, toolArgs, 'call-1',
    authorization(true), hooks(audits),
  )
  assert.equal(suspended.decision, 'suspend')
  const approval = fake.approvals[0]!
  assert.deepEqual((approval.resumeState as { args: unknown }).args, {
    approvalFingerprint: fingerprint('a'), draftId: ids.draft,
  })
  approve(approval)

  // The draft projection is rewritten whenever recipients or body change.
  state.contentFingerprint = fingerprint('b')
  const changed = await authorizeToolExecution(
    fake.prisma, actor(true), runContext(), GMAIL_DRAFT_SEND_TOOL_ID, toolArgs, 'call-1',
    authorization(false), hooks(audits),
  )
  assert.equal(changed.decision, 'deny')
  assert.equal(approval.proofConsumedAt, null)
})

test('an unchanged Gmail draft consumes its proof once and records one sanitized claim audit', async () => {
  const state = { contentFingerprint: fingerprint('c') }
  const fake = fakePrisma(state)
  const audits: Array<Record<string, unknown>> = []
  await authorizeToolExecution(
    fake.prisma, actor(), runContext(), GMAIL_DRAFT_SEND_TOOL_ID, toolArgs, 'call-2',
    authorization(true), hooks(audits),
  )
  const approval = fake.approvals[0]!
  approve(approval)

  const allowed = await authorizeToolExecution(
    fake.prisma, actor(true), runContext(), GMAIL_DRAFT_SEND_TOOL_ID, toolArgs, 'call-2',
    authorization(false), hooks(audits),
  )
  assert.equal(allowed.decision, 'allow')
  assert.ok(approval.proofConsumedAt instanceof Date)
  assert.deepEqual(allowed.decision === 'allow' ? allowed.args : null, {
    approvalFingerprint: fingerprint('c'), draftId: ids.draft,
  })

  const replay = await authorizeToolExecution(
    fake.prisma, actor(true), runContext(), GMAIL_DRAFT_SEND_TOOL_ID, toolArgs, 'call-2',
    authorization(false), hooks(audits),
  )
  assert.equal(replay.decision, 'deny')
  const claims = audits.filter((audit) => audit.approvalProofClaimed === true)
  assert.deepEqual(claims, [{
    agentId: ids.agent,
    approvalId: 'approval-1',
    approvalProofClaimed: true,
    continuationRunId: ids.run,
    outcome: 'success',
    runId: ids.run,
    taskId: ids.task,
    toolId: GMAIL_DRAFT_SEND_TOOL_ID,
  }])
})

test('a losing atomic Gmail proof claim does not record a successful claim audit', async () => {
  const fake = fakePrisma({ contentFingerprint: fingerprint('d') }, false)
  const audits: Array<Record<string, unknown>> = []
  await authorizeToolExecution(
    fake.prisma, actor(), runContext(), GMAIL_DRAFT_SEND_TOOL_ID, toolArgs, 'call-3',
    authorization(true), hooks(audits),
  )
  approve(fake.approvals[0]!)

  const denied = await authorizeToolExecution(
    fake.prisma, actor(true), runContext(), GMAIL_DRAFT_SEND_TOOL_ID, toolArgs, 'call-3',
    authorization(false), hooks(audits),
  )
  assert.equal(denied.decision, 'deny')
  assert.equal(audits.filter((audit) => audit.approvalProofClaimed === true).length, 0)
})

test('a model cannot supply an approval fingerprint', async () => {
  const fake = fakePrisma({ contentFingerprint: fingerprint('e') })
  const decision = await authorizeToolExecution(
    fake.prisma, actor(), runContext(), GMAIL_DRAFT_SEND_TOOL_ID,
    { ...toolArgs, approvalFingerprint: fingerprint('d') }, 'call-3', authorization(false), hooks([]),
  )
  assert.equal(decision.decision, 'deny')
})
