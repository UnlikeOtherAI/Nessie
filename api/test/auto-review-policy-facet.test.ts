import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

/** The auto-review facet is stored in the existing policy JSON, with no parallel gate table. */
runDatabaseTest('an auto-review policy facet persists on a tool rule', async (t) => {
  const prisma = new PrismaClient()
  const organization = await prisma.organization.create({
    data: { name: `auto-review-policy-${randomUUID()}` },
  })
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: organization.id } })
    await prisma.$disconnect()
  })

  const rule = await prisma.policyRule.create({
    data: {
      action: 'invoke',
      bindings: { create: { actorId: '*', actorType: 'user' } },
      conditions: { reviewMode: 'auto' },
      createdBy: `auto-review-test-${randomUUID()}`,
      effect: 'allow',
      organizationId: organization.id,
      resourceType: 'tool',
      scope: 'tool',
      scopeId: 'mcp_publish',
    },
    include: { bindings: true },
  })

  assert.deepEqual(rule.conditions, { reviewMode: 'auto' })
  assert.deepEqual(rule.bindings.map((binding) => [binding.actorType, binding.actorId]), [['user', '*']])
})
