import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  applyTaskChecklistTemplate,
  getTaskChecklist,
  updateTaskChecklistStep,
} from '../src/index.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('task checklist application is concurrent, idempotent, and preserves cleared results', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const agentId = randomUUID()
  const taskId = randomUUID()
  const userId = randomUUID()
  try {
    await prisma.organization.create({ data: { id: organizationId, name: `checklists-${organizationId}` } })
    await prisma.user.create({
      data: { id: userId, displayName: 'Checklist owner', email: `${userId}@example.test` },
    })
    await prisma.agent.create({ data: { id: agentId, name: 'Checklist agent', organizationId } })
    const task = await prisma.task.create({ data: { id: taskId, organizationId, title: 'Prospect Acme' } })
    const template = await prisma.agentTodoTemplate.create({
      data: {
        agentId,
        authorType: 'agent',
        name: 'Prospect research',
        organizationId,
        status: 'active',
        steps: [{ instructions: 'Verify the buyer.', key: 'verify-buyer', title: 'Verify buyer' }],
      },
    })
    const input = { agentId, createdByUserId: userId, organizationId, taskId: task.id, templateId: template.id }
    const [first, second] = await Promise.all([
      applyTaskChecklistTemplate(prisma, input),
      applyTaskChecklistTemplate(prisma, input),
    ])
    assert.ok(!('error' in first))
    assert.ok(!('error' in second))
    assert.equal(first.id, second.id)
    assert.equal(await prisma.taskChecklist.count({ where: { taskId: task.id } }), 1)
    assert.equal(await prisma.taskEvent.count({ where: { taskId: task.id, eventType: 'checklist_applied' } }), 1)

    const updated = await updateTaskChecklistStep(prisma, {
      checklistId: first.id,
      completed: true,
      organizationId,
      result: 'Buyer confirmed',
      stepKey: 'verify-buyer',
      taskId: task.id,
    })
    assert.equal(updated?.steps[0]?.result, 'Buyer confirmed')
    const cleared = await updateTaskChecklistStep(prisma, {
      checklistId: first.id,
      completed: false,
      organizationId,
      result: null,
      stepKey: 'verify-buyer',
      taskId: task.id,
    })
    assert.equal(cleared?.steps[0]?.result, null)
    assert.equal(cleared?.steps[0]?.completedAt, null)
    assert.equal((await getTaskChecklist(prisma, { organizationId, taskId }))?.id, first.id)
  } finally {
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.$disconnect()
  }
})
