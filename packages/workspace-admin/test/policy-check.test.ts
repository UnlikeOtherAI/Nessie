import assert from 'node:assert/strict'
import test from 'node:test'

import type { PolicyDecision } from '@nessie/schemas'

import {
  resolveDecision,
  type PolicyEvaluationOptions,
  type PolicyRuleRow,
  type PolicyScopeChain,
} from '../src/policy-check.js'

/**
 * Differential corpus for the one shared policy evaluator (security boundary
 * hardening, Workstream 5 / Sol CB-03). Both historical implementations ran
 * over the same cases here: the API configuration (`defaultVerdict` unset —
 * deny by default, approval never auto-satisfied) and the worker tool-invoke
 * configuration (`defaultVerdict: 'allow'` plus the run's approval proof).
 * The scenarios are the union of both copies' behaviours; each expectation is
 * written once per mode so a semantic drift in the shared evaluator fails
 * this table, not a production caller.
 */

const USER_ID = 'u-actor'
const AGENT_ID = 'a-agent'
const ORG_ID = 'o-org'
const PROJECT_ID = 'p-proj'
const TEAM_ID = 't-team'
const CHANNEL_ID = 'c-chan'
const TOOL_ID = 'tool-name'

const chain = (
  overrides: Partial<PolicyScopeChain> = {},
): PolicyScopeChain => ({
  actorId: USER_ID,
  actorRoles: ['member'],
  agentId: AGENT_ID,
  // buildScopeChain order: org, project, team, channel, agent, tool, actor —
  // the additional scope ids the worker passes for channel/agent/tool land in
  // the same positions.
  scopeIds: [ORG_ID, PROJECT_ID, TEAM_ID, CHANNEL_ID, AGENT_ID, TOOL_ID, USER_ID],
  ...overrides,
})

type RuleSpec = {
  actorId?: string
  actorType?: string
  conditions?: unknown
  effect: 'allow' | 'deny'
  id: string
  priority?: number
  scope?: string
  scopeId?: string
}

const rule = (spec: RuleSpec): PolicyRuleRow => ({
  action: 'invoke',
  actorId: spec.actorId ?? '*',
  actorType: spec.actorType ?? 'user',
  conditions: spec.conditions ?? null,
  effect: spec.effect,
  id: spec.id,
  priority: spec.priority ?? 1,
  resourceType: 'tool',
  scope: spec.scope ?? 'tool',
  scopeId: spec.scopeId ?? TOOL_ID,
})

type Expectation = {
  allowed: boolean
  approvalActionType?: string
  policyRuleId?: string
  policySource: string
  reasonCode: PolicyDecision['reasonCode']
}

type Case = {
  api: Expectation
  name: string
  options?: PolicyEvaluationOptions
  rules: PolicyRuleRow[]
  worker: Expectation
}

// Worker options as `evaluateToolInvokePolicy` passes them; `approvalProof`
// is overridden per-case where the scenario carries a proof.
const workerOptions = (overrides: PolicyEvaluationOptions = {}): PolicyEvaluationOptions => ({
  approvalProof: null,
  defaultVerdict: 'allow',
  ...overrides,
})

const cases: Case[] = [
  {
    name: 'no rules: API denies (NO_MATCHING_ALLOW), worker allows with source none',
    rules: [],
    api: { allowed: false, policySource: 'none', reasonCode: 'NO_MATCHING_ALLOW' },
    worker: { allowed: true, policySource: 'none', reasonCode: 'ALLOWED' },
  },
  {
    name: 'rules exist but none bind to the actor: same as no rules',
    rules: [rule({ id: 'rule-other', actorId: 'someone-else', effect: 'allow' })],
    api: { allowed: false, policySource: 'none', reasonCode: 'NO_MATCHING_ALLOW' },
    worker: { allowed: true, policySource: 'none', reasonCode: 'ALLOWED' },
  },
  {
    name: 'wildcard allow rule matches in both modes',
    rules: [rule({ id: 'rule-allow', effect: 'allow' })],
    api: {
      allowed: true,
      policyRuleId: 'rule-allow',
      policySource: 'tool:tool-name/allow',
      reasonCode: 'ALLOWED',
    },
    worker: {
      allowed: true,
      policyRuleId: 'rule-allow',
      policySource: 'tool:tool-name/allow',
      reasonCode: 'ALLOWED',
    },
  },
  {
    name: 'allow rule bound to this actor by user id',
    rules: [rule({ id: 'rule-user', actorId: USER_ID, effect: 'allow' })],
    api: {
      allowed: true,
      policyRuleId: 'rule-user',
      policySource: 'tool:tool-name/allow',
      reasonCode: 'ALLOWED',
    },
    worker: {
      allowed: true,
      policyRuleId: 'rule-user',
      policySource: 'tool:tool-name/allow',
      reasonCode: 'ALLOWED',
    },
  },
  {
    name: 'allow rule bound by role membership',
    rules: [rule({ id: 'rule-role', actorId: 'member', actorType: 'role', effect: 'allow' })],
    api: {
      allowed: true,
      policyRuleId: 'rule-role',
      policySource: 'tool:tool-name/allow',
      reasonCode: 'ALLOWED',
    },
    worker: {
      allowed: true,
      policyRuleId: 'rule-role',
      policySource: 'tool:tool-name/allow',
      reasonCode: 'ALLOWED',
    },
  },
  {
    name: 'allow rule bound by agent id',
    rules: [rule({ id: 'rule-agent', actorId: AGENT_ID, actorType: 'agent', effect: 'allow' })],
    api: {
      allowed: true,
      policyRuleId: 'rule-agent',
      policySource: 'tool:tool-name/allow',
      reasonCode: 'ALLOWED',
    },
    worker: {
      allowed: true,
      policyRuleId: 'rule-agent',
      policySource: 'tool:tool-name/allow',
      reasonCode: 'ALLOWED',
    },
  },
  {
    name: 'deny rule wins in both modes',
    rules: [rule({ id: 'rule-deny', effect: 'deny' })],
    api: {
      allowed: false,
      policyRuleId: 'rule-deny',
      policySource: 'tool:tool-name/deny',
      reasonCode: 'EXPLICIT_DENY',
    },
    worker: {
      allowed: false,
      policyRuleId: 'rule-deny',
      policySource: 'tool:tool-name/deny',
      reasonCode: 'EXPLICIT_DENY',
    },
  },
  {
    name: 'deny overrides an earlier-priority allow',
    rules: [
      rule({ id: 'rule-allow', effect: 'allow', priority: 1 }),
      rule({ id: 'rule-deny', effect: 'deny', priority: 2 }),
    ],
    api: {
      allowed: false,
      policyRuleId: 'rule-deny',
      policySource: 'tool:tool-name/deny',
      reasonCode: 'EXPLICIT_DENY',
    },
    worker: {
      allowed: false,
      policyRuleId: 'rule-deny',
      policySource: 'tool:tool-name/deny',
      reasonCode: 'EXPLICIT_DENY',
    },
  },
  {
    name: 'scope weight sorts before priority; deny at the same scope weight wins',
    rules: [
      rule({
        id: 'rule-deny-org',
        effect: 'deny',
        priority: 5,
        scope: 'organization',
        scopeId: ORG_ID,
      }),
      rule({
        id: 'rule-allow-org',
        effect: 'allow',
        priority: 1,
        scope: 'organization',
        scopeId: ORG_ID,
      }),
      rule({
        id: 'rule-allow-tool',
        effect: 'allow',
        priority: 1,
        scope: 'tool',
        scopeId: TOOL_ID,
      }),
    ],
    api: {
      allowed: false,
      policyRuleId: 'rule-deny-org',
      policySource: 'organization:o-org/deny',
      reasonCode: 'EXPLICIT_DENY',
    },
    worker: {
      allowed: false,
      policyRuleId: 'rule-deny-org',
      policySource: 'organization:o-org/deny',
      reasonCode: 'EXPLICIT_DENY',
    },
  },
  {
    name: 'scope-chain specificity: a tool-scoped allow outranks an org-scoped allow',
    rules: [
      rule({
        id: 'rule-allow-org',
        effect: 'allow',
        priority: 1,
        scope: 'organization',
        scopeId: ORG_ID,
      }),
      rule({
        id: 'rule-allow-tool',
        effect: 'allow',
        priority: 1,
        scope: 'tool',
        scopeId: TOOL_ID,
      }),
    ],
    api: {
      allowed: true,
      policyRuleId: 'rule-allow-tool',
      policySource: 'tool:tool-name/allow',
      reasonCode: 'ALLOWED',
    },
    worker: {
      allowed: true,
      policyRuleId: 'rule-allow-tool',
      policySource: 'tool:tool-name/allow',
      reasonCode: 'ALLOWED',
    },
  },
  {
    name: 'a channel-scope rule from the additional scope ids participates',
    rules: [
      rule({ id: 'rule-channel', effect: 'allow', scope: 'channel', scopeId: CHANNEL_ID }),
    ],
    api: {
      allowed: true,
      policyRuleId: 'rule-channel',
      policySource: 'channel:c-chan/allow',
      reasonCode: 'ALLOWED',
    },
    worker: {
      allowed: true,
      policyRuleId: 'rule-channel',
      policySource: 'channel:c-chan/allow',
      reasonCode: 'ALLOWED',
    },
  },
  {
    name: 'requiresApproval with no proof: APPROVAL_REQUIRED in both modes',
    rules: [
      rule({
        id: 'rule-approval',
        conditions: { approvalActionType: 'tool.invoke', requiresApproval: true },
        effect: 'allow',
      }),
    ],
    api: {
      allowed: false,
      approvalActionType: 'tool.invoke',
      policyRuleId: 'rule-approval',
      policySource: 'tool:tool-name/allow',
      reasonCode: 'APPROVAL_REQUIRED',
    },
    worker: {
      allowed: false,
      approvalActionType: 'tool.invoke',
      policyRuleId: 'rule-approval',
      policySource: 'tool:tool-name/allow',
      reasonCode: 'APPROVAL_REQUIRED',
    },
  },
  {
    name: 'requiresApproval satisfied by a proof in worker mode',
    rules: [
      rule({
        id: 'rule-approval',
        conditions: { approvalActionType: 'tool.invoke', requiresApproval: true },
        effect: 'allow',
      }),
    ],
    options: { approvalProof: 'proof-token' },
    api: {
      allowed: true,
      policyRuleId: 'rule-approval',
      policySource: 'tool:tool-name/allow',
      reasonCode: 'ALLOWED',
    },
    worker: {
      allowed: true,
      policyRuleId: 'rule-approval',
      policySource: 'tool:tool-name/allow',
      reasonCode: 'ALLOWED',
    },
  },
  {
    name: 'requiresApproval with no approvalActionType omits the field',
    rules: [rule({ id: 'rule-approval', conditions: { requiresApproval: true }, effect: 'allow' })],
    api: {
      allowed: false,
      policyRuleId: 'rule-approval',
      policySource: 'tool:tool-name/allow',
      reasonCode: 'APPROVAL_REQUIRED',
    },
    worker: {
      allowed: false,
      policyRuleId: 'rule-approval',
      policySource: 'tool:tool-name/allow',
      reasonCode: 'APPROVAL_REQUIRED',
    },
  },
  {
    name: 'a later plain allow still applies after an unsatisfied requiresApproval rule',
    rules: [
      rule({
        id: 'rule-approval',
        conditions: { requiresApproval: true },
        effect: 'allow',
        priority: 1,
      }),
      rule({ id: 'rule-plain', effect: 'allow', priority: 2 }),
    ],
    api: {
      allowed: false,
      policyRuleId: 'rule-approval',
      policySource: 'tool:tool-name/allow',
      reasonCode: 'APPROVAL_REQUIRED',
    },
    worker: {
      allowed: false,
      policyRuleId: 'rule-approval',
      policySource: 'tool:tool-name/allow',
      reasonCode: 'APPROVAL_REQUIRED',
    },
  },
  {
    name: 'malformed timeWindow (daysOfWeek not an array) fails closed in both modes',
    rules: [
      rule({
        id: 'rule-bad-tw',
        conditions: { timeWindow: { startHour: 0, endHour: 23, daysOfWeek: 'monday' } },
        effect: 'allow',
      }),
    ],
    api: { allowed: false, policySource: 'none', reasonCode: 'NO_MATCHING_ALLOW' },
    worker: { allowed: true, policySource: 'none', reasonCode: 'ALLOWED' },
  },
  {
    name: 'malformed timeWindow (not an object) fails closed in both modes',
    rules: [rule({ id: 'rule-bad-tw', conditions: { timeWindow: 'business hours' }, effect: 'allow' })],
    api: { allowed: false, policySource: 'none', reasonCode: 'NO_MATCHING_ALLOW' },
    worker: { allowed: true, policySource: 'none', reasonCode: 'ALLOWED' },
  },
  {
    name: 'malformed timeWindow on a deny rule also fails closed (rule never matches)',
    rules: [
      rule({
        id: 'rule-bad-tw-deny',
        conditions: { timeWindow: { startHour: 0, endHour: 23 } },
        effect: 'deny',
      }),
      rule({ id: 'rule-allow', effect: 'allow', priority: 2 }),
    ],
    api: {
      allowed: true,
      policyRuleId: 'rule-allow',
      policySource: 'tool:tool-name/allow',
      reasonCode: 'ALLOWED',
    },
    worker: {
      allowed: true,
      policyRuleId: 'rule-allow',
      policySource: 'tool:tool-name/allow',
      reasonCode: 'ALLOWED',
    },
  },
  {
    name: 'valid timeWindow outside the current window keeps the rule out of evaluation',
    rules: [
      rule({
        id: 'rule-tw',
        conditions: {
          timeWindow: {
            startHour: 0,
            endHour: 24,
            // Tomorrow only: today can never be in this window.
            daysOfWeek: [(new Date().getUTCDay() + 1) % 7],
          },
        },
        effect: 'allow',
      }),
    ],
    api: { allowed: false, policySource: 'none', reasonCode: 'NO_MATCHING_ALLOW' },
    worker: { allowed: true, policySource: 'none', reasonCode: 'ALLOWED' },
  },
]

const expectDecision = (actual: PolicyDecision, expected: Expectation): void => {
  assert.equal(actual.allowed, expected.allowed)
  assert.equal(actual.policyRuleId, expected.policyRuleId)
  assert.equal(actual.policySource, expected.policySource)
  assert.equal(actual.reasonCode, expected.reasonCode)
  if (expected.approvalActionType === undefined) {
    assert.equal(actual.approvalActionType, undefined)
  } else {
    assert.equal(actual.approvalActionType, expected.approvalActionType)
  }
  if (expected.reasonCode === 'APPROVAL_REQUIRED') {
    assert.equal(actual.requiresApproval, true)
  } else {
    assert.equal(actual.requiresApproval, undefined)
  }
}

for (const c of cases) {
  test(`API configuration — ${c.name}`, () => {
    expectDecision(resolveDecision(c.rules.map((r) => ({ ...r })), chain(), c.options), c.api)
  })

  test(`worker configuration — ${c.name}`, () => {
    expectDecision(
      resolveDecision(
        c.rules.map((r) => ({ ...r })),
        chain(),
        workerOptions(c.options),
      ),
      c.worker,
    )
  })
}

// Time-window sanity: a window that definitely contains "now" matches.
test('valid timeWindow containing now matches', () => {
  const now = new Date()
  const tw = {
    startHour: now.getUTCHours(),
    endHour: (now.getUTCHours() + 2) % 24,
    daysOfWeek: [now.getUTCDay()],
  }
  const decision = resolveDecision(
    [rule({ id: 'rule-tw', conditions: { timeWindow: tw }, effect: 'allow' })],
    chain(),
  )
  assert.equal(decision.allowed, true)
  assert.equal(decision.policyRuleId, 'rule-tw')
})
