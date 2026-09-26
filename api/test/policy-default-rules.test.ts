import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { parseOrganizationId, parseTeamId, type AuthorizedActionContext } from '@nessie/schemas'

import { registerPolicyRoutes } from '../src/routes/policy.js'
import {
  defaultPolicyRuleKind,
  NEW_ORGANIZATION_DEFAULT_POLICIES,
  SELF_HEALING_DEFAULT_POLICIES,
} from '../src/services/policy-defaults.js'
import {
  deletePolicyRule,
  listPolicyRules,
  PolicyRuleError,
  removePolicyBinding,
} from '../src/services/policy-rules.js'

// Plan §9: the Access rules page "can break an organisation with two clicks".
// The defaults every organisation starts with split in two. Reconcile writes
// the self-healing ones back on every deploy, so deleting one is undone; the
// rest are written once, for a new organisation, and nothing restores them —
// deleting "every role may view channels" took effect for every member at once
// and for good. Those cannot be deleted, nor emptied of their binding.

const ORG = '32000000-0000-4000-8000-000000000001'
const PROTECTED_KEY = 'default:channel:view:allow:*'
const RESTORED_KEY = 'default:knowledge_space:view:allow:*'

test('every default is exactly one of restored or protected', () => {
  const restored = new Set(SELF_HEALING_DEFAULT_POLICIES.map((rule) => rule.seedKey))
  for (const rule of NEW_ORGANIZATION_DEFAULT_POLICIES) {
    assert.equal(
      defaultPolicyRuleKind(rule.seedKey),
      restored.has(rule.seedKey) ? 'restored' : 'protected',
      rule.seedKey,
    )
  }
  assert.equal(defaultPolicyRuleKind(PROTECTED_KEY), 'protected')
  assert.equal(defaultPolicyRuleKind(RESTORED_KEY), 'restored')
  assert.equal(defaultPolicyRuleKind(null), null)
  assert.equal(defaultPolicyRuleKind('default:not-a-default'), null)
})

const rulesPrisma = (seedKey: string | null | undefined) => {
  const deleted: string[] = []
  const prisma = {
    policyRule: {
      findFirst: async () => (seedKey === undefined ? null : { seedKey }),
      delete: async ({ where }: { where: { id: string } }) => {
        deleted.push(where.id)
        return {}
      },
    },
  } as unknown as PrismaClient
  return { deleted, prisma }
}

test('a protected default cannot be deleted; a restored one and an owner rule can', async () => {
  const protectedRule = rulesPrisma(PROTECTED_KEY)
  await assert.rejects(
    deletePolicyRule(protectedRule.prisma, 'rule-1', ORG),
    (error: unknown) => error instanceof PolicyRuleError && error.code === 'POLICY_RULE_PROTECTED',
  )
  assert.deepEqual(protectedRule.deleted, [])

  for (const seedKey of [RESTORED_KEY, null]) {
    const allowed = rulesPrisma(seedKey)
    await deletePolicyRule(allowed.prisma, 'rule-2', ORG)
    assert.deepEqual(allowed.deleted, ['rule-2'])
  }

  await assert.rejects(
    deletePolicyRule(rulesPrisma(undefined).prisma, 'rule-3', ORG),
    (error: unknown) => error instanceof PolicyRuleError && error.code === 'POLICY_RULE_NOT_FOUND',
  )
})

test('a protected default cannot be emptied by removing its binding', async () => {
  let removed = 0
  const prismaFor = (seedKey: string | null) => ({
    policyBinding: {
      findFirst: async () => ({ policyRule: { seedKey } }),
      deleteMany: async () => {
        removed += 1
        return { count: 1 }
      },
    },
  }) as unknown as PrismaClient

  await assert.rejects(
    removePolicyBinding(prismaFor(PROTECTED_KEY), 'binding-1', ORG),
    (error: unknown) => error instanceof PolicyRuleError && error.code === 'POLICY_RULE_PROTECTED',
  )
  assert.equal(removed, 0)
  assert.equal(await removePolicyBinding(prismaFor(null), 'binding-2', ORG), true)
  assert.equal(removed, 1)
})

test('each listed rule says which kind of default it is', async () => {
  const row = (id: string, seedKey: string | null) => ({
    action: 'view',
    bindings: [{ actorId: '*', actorType: 'role', id: `${id}-binding` }],
    conditions: null,
    createdAt: new Date('2026-09-26T00:00:00Z'),
    createdBy: 'system',
    effect: 'allow',
    id,
    organizationId: ORG,
    priority: 100,
    resourceType: 'channel',
    scope: 'organization',
    scopeId: ORG,
    seedKey,
    updatedAt: new Date('2026-09-26T00:00:00Z'),
  })
  const prisma = {
    policyRule: {
      count: async () => 3,
      findMany: async () => [row('a', PROTECTED_KEY), row('b', RESTORED_KEY), row('c', null)],
    },
  } as unknown as PrismaClient

  const page = await listPolicyRules(prisma, ORG)
  assert.deepEqual(
    page.data.map((rule) => [rule.id, rule.defaultRule]),
    [['a', 'protected'], ['b', 'restored'], ['c', null]],
  )
})

test('the delete route answers a protected default with 409 and its reason', async () => {
  const actorContext: AuthorizedActionContext = {
    actor: { actorId: '32000000-0000-4000-8000-000000000002', actorType: 'user', roles: ['owner'] },
    actionContext: { requestId: 'policy-default-rules' },
    tenant: { organizationId: parseOrganizationId(ORG), teamId: parseTeamId('32000000-0000-4000-8000-000000000003') },
  }
  const app = Fastify({ logger: false })
  registerPolicyRoutes(app, {
    prisma: rulesPrisma(PROTECTED_KEY).prisma,
    requireActorContext: () => actorContext,
    requireOwner: () => true,
  } as unknown as Parameters<typeof registerPolicyRoutes>[1])
  try {
    const response = await app.inject({ method: 'DELETE', url: '/api/policy/rules/rule-1' })
    assert.equal(response.statusCode, 409)
    assert.equal(JSON.parse(response.body).error.code, 'POLICY_RULE_PROTECTED')
  } finally {
    await app.close()
  }
})
