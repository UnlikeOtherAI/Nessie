import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { hashJsonValue } from '../tool-util.js'
import { createConsumedSourceSink } from './disclosure-basis.js'
import { evaluateToolInvokePolicy } from './policy.js'
import type { RunContext } from './types.js'

const ORG_ID = '11111111-1111-4111-8111-111111111111'
const PROJECT_ID = '22222222-2222-4222-8222-222222222222'
const TEAM_ID = '33333333-3333-4333-8333-333333333333'
const CHANNEL_ID = '44444444-4444-4444-8444-444444444444'
const AGENT_ID = '55555555-5555-4555-8555-555555555555'
const PARENT_RUN_ID = '66666666-6666-4666-8666-666666666666'
const CONTINUATION_RUN_ID = '77777777-7777-4777-8777-777777777777'
const TASK_ID = '88888888-8888-4888-8888-888888888888'
const THREAD_ID = '99999999-9999-4999-8999-999999999999'

const args = { amount: 2, recipient: 'bonjour' }

const context = (): RunContext => ({
  agent: {
    agentKind: 'shared',
    effort: 'medium',
    executionMode: 'inference',
    id: AGENT_ID,
    model: null,
    name: 'Approvals Agent',
    parentAgentId: null,
    provider: null,
    systemPrompt: null,
  },
  boundAgentIds: [],
  channel: {
    id: CHANNEL_ID,
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    teamId: TEAM_ID,
    systemChannelType: null,
  },
  consumedSources: createConsumedSourceSink(),
  run: { createdAt: new Date(), id: CONTINUATION_RUN_ID, replyPlacement: null, threadId: THREAD_ID },
  task: { id: TASK_ID },
})

const actor = (approval?: Partial<NonNullable<AuthorizedActionContext['approval']>>): AuthorizedActionContext => ({
  actor: { actorId: 'human-actor', actorType: 'user', roles: ['member'] },
  approval: approval
    ? { approvalId: 'approval-1', approvalProof: 'verified-token', ...approval }
    : undefined,
  actionContext: { requestId: 'policy-proof-test' },
  tenant: {
    organizationId: parseOrganizationId(ORG_ID),
    projectId: parseProjectId(PROJECT_ID),
    teamId: parseTeamId(TEAM_ID),
  },
})

const rule = {
  action: 'invoke',
  bindings: [{ actorId: '*', actorType: 'user' }],
  conditions: { requiresApproval: true },
  effect: 'allow',
  id: 'approval-rule',
  priority: 1,
  resourceType: 'tool',
  scope: 'tool',
  scopeId: 'payment_send',
}

const fakePrisma = (input: {
  args?: Record<string, unknown>
  approval?: Partial<Record<string, unknown>>
  continuationOfRunId?: string | null
}) => {
  const approval: {
    [key: string]: unknown
    action: string
    argsHash: string
    continuationToken: string
    id: string
    organizationId: string
    proofConsumedAt: Date | null
    runId: string
    status: string
    toolName: string
  } = {
    action: 'tool.invoke',
    argsHash: hashJsonValue(args),
    continuationToken: 'verified-token',
    id: 'approval-1',
    organizationId: ORG_ID,
    proofConsumedAt: null,
    runId: PARENT_RUN_ID,
    status: 'approved',
    toolName: 'payment_send',
    ...input.approval,
  }
  return {
    approval,
    prisma: {
      approvalRequest: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          Object.entries(where).every(([key, value]) => approval[key] === value)
            ? { id: approval.id, runId: approval.runId }
            : null,
        updateMany: async ({ where }: { where: Record<string, unknown> }) => {
          if (!Object.entries(where).every(([key, value]) => approval[key] === value)) {
            return { count: 0 }
          }
          approval.proofConsumedAt = new Date()
          return { count: 1 }
        },
      },
      policyRule: { findMany: async () => [rule] },
      run: {
        findUnique: async () => ({ continuationOfRunId: input.continuationOfRunId ?? PARENT_RUN_ID }),
      },
    },
  }
}

test('a verified proof authorizes exactly the approved canonical arguments once', async () => {
  const fake = fakePrisma({})
  const first = await evaluateToolInvokePolicy(
    fake.prisma as never,
    actor({}),
    context(),
    'payment_send',
    args,
  )
  assert.equal(first.allowed, true)
  assert.ok(fake.approval.proofConsumedAt instanceof Date)

  const replay = await evaluateToolInvokePolicy(
    fake.prisma as never,
    actor({}),
    context(),
    'payment_send',
    args,
  )
  assert.deepEqual(replay, {
    allowed: false,
    approvalActionType: undefined,
    policyRuleId: 'approval-rule',
    policySource: 'tool:payment_send/allow',
    reason: 'approval_required',
  })
})

for (const [name, input] of [
  ['a different organization', { approval: { organizationId: 'foreign-org' } }],
  ['a different tool', { approval: { toolName: 'other_tool' } }],
  ['different arguments', { args: { amount: 3, recipient: 'bonjour' } }],
  ['a non-lineage run', { continuationOfRunId: 'other-run' }],
  ['a rejected approval', { approval: { status: 'rejected' } }],
] as const) {
  test(`a proof from ${name} cannot satisfy the policy gate`, async () => {
    const fake = fakePrisma(input)
    const decision = await evaluateToolInvokePolicy(
      fake.prisma as never,
      actor({}),
      context(),
      'payment_send',
    input.args ?? args,
    )
    assert.equal(decision.allowed, false)
    if (!decision.allowed) assert.equal(decision.reason, 'approval_required')
    assert.equal(fake.approval.proofConsumedAt, null)
  })
}
