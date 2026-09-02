import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PrismaClient } from '@prisma/client'
import { applyBudgetGate } from '../src/run/execute/budget-gate.js'
import { resolveRunSubscriptionBinding } from '../src/run/execute/subscription-binding.js'
import type { ExecutionDependencies, RunContext } from '../src/run/execute/types.js'

/**
 * The lane decision: which purse a run spends, and what the organization budget
 * is allowed to do about it.
 *
 * Spec: docs/plans/2026-09-02-personal-model-subscriptions.md §2.4.
 */

const baseContext = (agent: Partial<RunContext['agent']>): RunContext => ({
  agent: {
    agentKind: 'shared',
    effort: 'medium',
    executionMode: 'inference',
    id: 'agent-1',
    model: 'glm-4.6',
    name: 'Test',
    ownerUserId: 'user-1',
    parentAgentId: null,
    provider: null,
    runLimits: null,
    systemPrompt: null,
    ...agent,
  },
  channel: { id: 'chan-1', organizationId: 'org-1' },
  run: { id: 'run-1', threadId: 'thread-1' },
} as unknown as RunContext)

const depsWith = (overrides: Record<string, unknown> = {}): ExecutionDependencies => ({
  prisma: {
    modelSubscription: {
      findFirst: async () => overrides.subscription ?? null,
    },
    organizationMember: {
      findUnique: async () => overrides.membership ?? { deactivatedAt: null },
    },
  },
} as unknown as ExecutionDependencies)

test('an ordinary agent resolves to the Ledger lane', async () => {
  const resolution = await resolveRunSubscriptionBinding(
    depsWith(),
    baseContext({ provider: 'openai' }),
  )
  assert.equal(resolution.kind, 'ledger')
})

test('a dangling subscription pointer fails closed rather than falling back to Ledger', async () => {
  // Disconnecting sets the agent's pointer to NULL (SetNull). Falling back here
  // would quietly move the person's spend onto the organization.
  const resolution = await resolveRunSubscriptionBinding(
    depsWith(),
    baseContext({ modelSubscriptionId: null, provider: 'subscription/glm' }),
  )
  assert.equal(resolution.kind, 'unavailable')
})

test('an adapter this process does not know fails closed', async () => {
  // The rolling-deploy case: an API replica wrote a selection a newer release
  // understands and this worker does not.
  const resolution = await resolveRunSubscriptionBinding(
    depsWith(),
    baseContext({
      modelSubscriptionId: '11111111-1111-4111-8111-111111111111',
      provider: 'subscription/some-future-provider',
    }),
  )
  assert.equal(resolution.kind, 'unavailable')
})

test('an agent with no owner cannot spend a personal plan', async () => {
  const resolution = await resolveRunSubscriptionBinding(
    depsWith(),
    baseContext({
      modelSubscriptionId: '11111111-1111-4111-8111-111111111111',
      ownerUserId: null,
      provider: 'subscription/glm',
    }),
  )
  assert.equal(resolution.kind, 'unavailable')
})

test('a healthy link pins the subscription and its credential generation', async () => {
  const resolution = await resolveRunSubscriptionBinding(
    depsWith({
      subscription: {
        credentialEpoch: 7,
        id: '11111111-1111-4111-8111-111111111111',
        organizationId: 'org-1',
        provider: 'glm',
        status: 'active',
        userId: 'user-1',
      },
    }),
    baseContext({
      modelSubscriptionId: '11111111-1111-4111-8111-111111111111',
      provider: 'subscription/glm',
    }),
  )
  assert.equal(resolution.kind, 'subscription')
  if (resolution.kind !== 'subscription') return
  assert.equal(resolution.binding.epoch, 7)
  assert.equal(resolution.binding.ownerUserId, 'user-1')
})

test('the organization budget does not gate a run the organization is not paying for', async () => {
  // evaluateBudget would throw on this fake prisma if it were reached at all,
  // which is exactly the assertion: a pinned run never consults it.
  const deps = {
    prisma: {
      $queryRaw: () => {
        throw new Error('budget evaluation must not run for a subscription lane')
      },
    },
  } as unknown as ExecutionDependencies
  const verdict = await applyBudgetGate(
    deps,
    baseContext({ provider: 'subscription/glm' }),
    { actorContext: { tenant: { organizationId: 'org-1' } } } as never,
    { subscriptionPinned: true },
  )
  assert.deepEqual(verdict, { blocked: false, modelOverride: null })
})
