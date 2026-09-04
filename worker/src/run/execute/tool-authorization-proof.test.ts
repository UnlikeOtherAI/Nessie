import assert from 'node:assert/strict'
import test from 'node:test'

import { parseOrganizationId, parseProjectId, parseTeamId, type AuthorizedActionContext } from '@nessie/schemas'

import { hashJsonValue } from '../tool-util.js'
import { authorizeToolExecution } from './tool-authorization.js'
import type { RunContext } from './types.js'

const ORG = '11111111-1111-4111-8111-111111111111'
const PROJECT = '22222222-2222-4222-8222-222222222222'
const TEAM = '33333333-3333-4333-8333-333333333333'
const CHANNEL = '44444444-4444-4444-8444-444444444444'
const AGENT = '55555555-5555-4555-8555-555555555555'
const SUSPENDED = '66666666-6666-4666-8666-666666666666'
const CONTINUATION = '77777777-7777-4777-8777-777777777777'
const TASK = '88888888-8888-4888-8888-888888888888'
const THREAD = '99999999-9999-4999-8999-999999999999'
const ARGS = { subject: 'Receipt', text: 'Private words', to: ['person@example.test'] }

const context = (): RunContext => ({
  agent: { agentKind: 'shared', id: AGENT, parentAgentId: null },
  boundAgentIds: [],
  channel: { id: CHANNEL, organizationId: ORG, projectId: PROJECT, teamId: TEAM },
  run: { id: CONTINUATION, threadId: THREAD },
  task: { id: TASK },
}) as unknown as RunContext

const actor = (): AuthorizedActionContext => ({
  actor: { actorId: 'person', actorType: 'user', roles: [] },
  approval: { approvalId: 'approval-1', approvalProof: 'proof' },
  actionContext: { requestId: 'structural-proof-test' },
  tenant: {
    organizationId: parseOrganizationId(ORG),
    projectId: parseProjectId(PROJECT),
    teamId: parseTeamId(TEAM),
  },
})

const fakePrisma = (input: { args?: Record<string, unknown>; toolName?: string } = {}) => {
  const approval = {
    action: 'tool.invoke',
    argsHash: hashJsonValue(input.args ?? ARGS),
    continuationToken: 'proof',
    id: 'approval-1',
    organizationId: ORG,
    proofConsumedAt: null as Date | null,
    runId: SUSPENDED,
    status: 'approved',
    toolName: input.toolName ?? 'mailbox_send',
  }
  const matches = (where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => approval[key as keyof typeof approval] === value)
  return {
    approval,
    prisma: {
      approvalRequest: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          matches(where) ? { id: approval.id, runId: approval.runId } : null,
        updateMany: async ({ where }: { where: Record<string, unknown> }) => {
          if (!matches(where)) return { count: 0 }
          approval.proofConsumedAt = new Date()
          return { count: 1 }
        },
      },
      policyRule: { findMany: async () => [] },
      run: { findUnique: async () => ({ continuationOfRunId: SUSPENDED }) },
    },
  }
}

const authorize = async (prisma: ReturnType<typeof fakePrisma>['prisma'], args = ARGS) => {
  let structuralCalls = 0
  const decision = await authorizeToolExecution(
    prisma as never,
    actor(),
    context(),
    'mailbox_send',
    args,
    'tool-call',
    {
      agentKind: 'shared',
      allowedToolIds: new Set(['mailbox_send']),
      maySuspendForApproval: false,
      parentAgentId: null,
      resolvedBuiltinToolIds: new Set(['mailbox_send']),
      structuralGate: async () => {
        structuralCalls += 1
        return { escalate: true }
      },
      toolPolicy: { mailbox_send: true },
    },
    { deepWaterHandoffGuard: { suppressBuiltin: async () => false } as never, emitAudit: async () => undefined },
  )
  return { decision, structuralCalls }
}

for (const [name, fake, callArgs] of [
  ['altered arguments', fakePrisma({ args: { ...ARGS, text: 'Changed' } }), ARGS],
  ['a cross-tool proof', fakePrisma({ toolName: 'gmail_draft_send' }), ARGS],
] as const) {
  test(`a raw ${name} proof cannot bypass a structural gate`, async () => {
    const result = await authorize(fake.prisma, callArgs)
    assert.equal(result.structuralCalls, 1)
    assert.equal(result.decision.decision, 'deny')
    assert.equal(fake.approval.proofConsumedAt, null)
  })
}

test('an exact structural proof bypasses once and is consumed only at dispatch', async () => {
  const fake = fakePrisma()
  const first = await authorize(fake.prisma)
  assert.equal(first.structuralCalls, 0)
  assert.equal(first.decision.decision, 'allow')
  assert.ok(fake.approval.proofConsumedAt instanceof Date)

  const replay = await authorize(fake.prisma)
  assert.equal(replay.structuralCalls, 1)
  assert.equal(replay.decision.decision, 'deny')
})
