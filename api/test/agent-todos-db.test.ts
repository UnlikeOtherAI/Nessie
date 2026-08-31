import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'

import {
  CreateAgentBodySchema,
  UpdateAgentBodySchema,
} from '../src/contracts/agents.js'
import { updateAgentRecord } from '../src/services/agent-management.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  agentId: string
  otherAgentId: string
  organizationId: string
  otherOrganizationId: string
}

const templateSteps = [
  {
    instructions: 'Gather the facts.',
    key: 'gather-facts',
    title: 'Gather facts',
  },
]

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const organizationId = randomUUID()
  const otherOrganizationId = randomUUID()
  const agentId = randomUUID()
  const otherAgentId = randomUUID()

  await prisma.organization.createMany({
    data: [
      { id: organizationId, name: `agent-todos-${organizationId}` },
      { id: otherOrganizationId, name: `agent-todos-${otherOrganizationId}` },
    ],
  })
  await prisma.agent.createMany({
    data: [
      { id: agentId, name: 'Todo agent', organizationId },
      { id: otherAgentId, name: 'Other todo agent', organizationId },
    ],
  })

  return { agentId, organizationId, otherAgentId, otherOrganizationId }
}

const cleanup = async (prisma: PrismaClient, value: Seed) => {
  await prisma.agentTodo.deleteMany({
    where: { organizationId: { in: [value.organizationId, value.otherOrganizationId] } },
  })
  await prisma.agentTodoTemplate.deleteMany({
    where: { organizationId: { in: [value.organizationId, value.otherOrganizationId] } },
  })
  await prisma.agent.deleteMany({ where: { id: { in: [value.agentId, value.otherAgentId] } } })
  await prisma.organization.deleteMany({
    where: { id: { in: [value.organizationId, value.otherOrganizationId] } },
  })
}

const withDatabase = async (run: (prisma: PrismaClient, value: Seed) => Promise<void>) => {
  const prisma = new PrismaClient()
  let value: Seed | undefined

  try {
    value = await seed(prisma)
    await run(prisma, value)
  } finally {
    if (value) {
      await cleanup(prisma, value)
    }
    await prisma.$disconnect()
  }
}

const isForeignKeyViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003'

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

test('agent create and update contracts accept todosEnabled', () => {
  const created = CreateAgentBodySchema.safeParse({ name: 'Todo agent', todosEnabled: true })
  const updated = UpdateAgentBodySchema.safeParse({ todosEnabled: false })

  assert.equal(created.success, true)
  assert.equal(created.success ? created.data.todosEnabled : undefined, true)
  assert.equal(updated.success, true)
  assert.equal(updated.success ? updated.data.todosEnabled : undefined, false)
})

dbTest('a shared agent update persists and returns todosEnabled', async () => {
  await withDatabase(async (prisma, value) => {
    const updated = await updateAgentRecord(prisma, value.agentId, {
      organizationId: value.organizationId,
      todosEnabled: true,
    })

    assert.equal(updated?.todosEnabled, true)
    const row = await prisma.agent.findUnique({
      where: { id: value.agentId },
      select: { todosEnabled: true },
    })
    assert.equal(row?.todosEnabled, true)
  })
})

dbTest('a system-managed agent update preserves its stored todosEnabled value', async () => {
  await withDatabase(async (prisma, value) => {
    await prisma.agent.update({
      where: { id: value.agentId },
      data: { systemManaged: true, todosEnabled: true },
    })

    const updated = await updateAgentRecord(prisma, value.agentId, {
      organizationId: value.organizationId,
      todosEnabled: false,
    })

    assert.equal(updated?.todosEnabled, true)
    const row = await prisma.agent.findUnique({
      where: { id: value.agentId },
      select: { todosEnabled: true },
    })
    assert.equal(row?.todosEnabled, true)
  })
})

dbTest('the database rejects an AgentTodo whose organization differs from its agent', async () => {
  await withDatabase(async (prisma, value) => {
    await assert.rejects(
      () =>
        prisma.agentTodo.create({
          data: {
            agentId: value.agentId,
            organizationId: value.otherOrganizationId,
            title: 'Cross-organization to-do',
          },
        }),
      isForeignKeyViolation,
      'the composite organization/agent FK must reject a cross-organization to-do',
    )
  })
})

dbTest('the database rejects an AgentTodo using a template from another agent', async () => {
  await withDatabase(async (prisma, value) => {
    const template = await prisma.agentTodoTemplate.create({
      data: {
        agentId: value.agentId,
        authorType: 'user',
        name: 'Source agent template',
        organizationId: value.organizationId,
        steps: templateSteps,
      },
    })

    await assert.rejects(
      () =>
        prisma.agentTodo.create({
          data: {
            agentId: value.otherAgentId,
            organizationId: value.organizationId,
            templateId: template.id,
            title: 'Wrong-agent template instance',
          },
        }),
      isForeignKeyViolation,
      'the composite agent/template FK must reject another agent\'s template',
    )
  })
})

dbTest('the database rejects duplicate AgentTodo step keys', async () => {
  await withDatabase(async (prisma, value) => {
    const todo = await prisma.agentTodo.create({
      data: {
        agentId: value.agentId,
        organizationId: value.organizationId,
        title: 'Unique step keys',
      },
    })

    await prisma.agentTodoStep.create({
      data: {
        instructions: 'Do this first.',
        key: 'same-key',
        sequence: 0,
        title: 'First',
        todoId: todo.id,
      },
    })

    await assert.rejects(
      () =>
        prisma.agentTodoStep.create({
          data: {
            instructions: 'This must not be accepted.',
            key: 'same-key',
            sequence: 1,
            title: 'Second',
            todoId: todo.id,
          },
        }),
      isUniqueViolation,
      'the per-to-do step key constraint must reject duplicate keys',
    )
  })
})

dbTest('deleting an AgentTodo cascades to its steps', async () => {
  await withDatabase(async (prisma, value) => {
    const todo = await prisma.agentTodo.create({
      data: {
        agentId: value.agentId,
        organizationId: value.organizationId,
        title: 'Cascade steps',
      },
    })
    const step = await prisma.agentTodoStep.create({
      data: {
        instructions: 'This row must be removed with its to-do.',
        key: 'cascade-step',
        sequence: 0,
        title: 'Cascade step',
        todoId: todo.id,
      },
    })

    await prisma.agentTodo.delete({ where: { id: todo.id } })

    assert.equal(
      await prisma.agentTodoStep.findUnique({ where: { id: step.id } }),
      null,
      'the step must not survive deletion of its parent to-do',
    )
  })
})

dbTest('the database restricts deleting a template that still has instances', async () => {
  await withDatabase(async (prisma, value) => {
    const template = await prisma.agentTodoTemplate.create({
      data: {
        agentId: value.agentId,
        authorType: 'user',
        name: 'Protected template',
        organizationId: value.organizationId,
        steps: templateSteps,
      },
    })
    await prisma.agentTodo.create({
      data: {
        agentId: value.agentId,
        organizationId: value.organizationId,
        templateId: template.id,
        templateVersion: template.version,
        title: 'Protected instance',
      },
    })

    await assert.rejects(
      () => prisma.agentTodoTemplate.delete({ where: { id: template.id } }),
      isForeignKeyViolation,
      'template deletion must be RESTRICT while an instance retains provenance',
    )
  })
})
