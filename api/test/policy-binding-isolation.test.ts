import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { addPolicyBinding, removePolicyBinding } from '../src/services/policy-rules.js'

// Cross-tenant isolation for policy-binding writes. The routes are owner-gated,
// but ownership is per-org: an owner of org A must not be able to attach a
// binding to org B's rule, nor delete org B's binding, by passing a foreign id.

const orgA = '00000000-0000-4000-8000-0000000000a1'
const orgB = '00000000-0000-4000-8000-0000000000b2'
const ruleInOrgA = '00000000-0000-4000-8000-0000000000c3'
const bindingInOrgA = '00000000-0000-4000-8000-0000000000d4'

const rules = [{ id: ruleInOrgA, organizationId: orgA }]
const bindings = [{ id: bindingInOrgA, organizationId: orgA }]

let created = 0

const prisma = {
  policyRule: {
    findFirst: async ({ where }: { where: { id: string; organizationId: string } }) =>
      rules.find((r) => r.id === where.id && r.organizationId === where.organizationId)
        ? { id: where.id }
        : null,
  },
  policyBinding: {
    create: async ({ data }: { data: { policyRuleId: string; actorType: string; actorId: string } }) => {
      created += 1
      return { id: 'new-binding', actorType: data.actorType, actorId: data.actorId }
    },
    deleteMany: async ({
      where,
    }: {
      where: { id: string; policyRule: { is: { organizationId: string } } }
    }) => {
      const org = where.policyRule.is.organizationId
      const count = bindings.filter((b) => b.id === where.id && b.organizationId === org).length
      return { count }
    },
  },
} as unknown as PrismaClient

test('addPolicyBinding attaches when the rule belongs to the caller org', async () => {
  created = 0
  const result = await addPolicyBinding(prisma, ruleInOrgA, orgA, 'role', 'member')
  assert.ok(result, 'expected a binding to be returned')
  assert.equal(created, 1, 'binding should have been created')
})

test('addPolicyBinding refuses a rule owned by another org (no write)', async () => {
  created = 0
  const result = await addPolicyBinding(prisma, ruleInOrgA, orgB, 'role', 'member')
  assert.equal(result, null, 'cross-tenant add must return null')
  assert.equal(created, 0, 'no binding may be created for a foreign rule')
})

test('removePolicyBinding deletes a binding in the caller org', async () => {
  const removed = await removePolicyBinding(prisma, bindingInOrgA, orgA)
  assert.equal(removed, true)
})

test('removePolicyBinding refuses a binding owned by another org', async () => {
  const removed = await removePolicyBinding(prisma, bindingInOrgA, orgB)
  assert.equal(removed, false, 'cross-tenant delete must be a no-op')
})
