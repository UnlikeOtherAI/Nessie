import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { runApprovalEffect } from '../src/services/approval-effects.js'

test('workflow.template.adopt writes the durable adoption decision before installation can proceed', async () => {
  const calls: unknown[] = []
  // This cast fake models the new workflowTemplate.updateMany query. Keeping
  // it here makes a missing delegate fail as the runtime TypeError it would be
  // in every other Prisma fake, rather than silently widening an approval.
  const prisma = {
    workflowTemplate: {
      updateMany: async (input: unknown) => {
        calls.push(input)
        return { count: 1 }
      },
    },
  } as unknown as PrismaClient
  const context: AuthorizedActionContext = {
    actionContext: { requestId: 'workflow-adoption-test' },
    actor: { actorId: '10000000-0000-4000-8000-000000000001', actorType: 'user' },
    tenant: { organizationId: '10000000-0000-4000-8000-000000000002' },
  }

  const result = await runApprovalEffect(prisma, {
    action: 'workflow.template.adopt',
    context: { workflowTemplateId: '10000000-0000-4000-8000-000000000003' },
    id: '10000000-0000-4000-8000-000000000004',
  }, context)

  assert.equal(result.note, 'learned workflow adopted')
  const [call] = calls as Array<{
    data: { adoptedAt: Date }
    where: Record<string, unknown>
  }>
  assert.ok(call)
  assert.ok(call.data.adoptedAt instanceof Date)
  assert.deepEqual(call.where, {
    adoptedAt: null,
    id: '10000000-0000-4000-8000-000000000003',
    organizationId: '10000000-0000-4000-8000-000000000002',
    source: 'demonstration',
  })
})
