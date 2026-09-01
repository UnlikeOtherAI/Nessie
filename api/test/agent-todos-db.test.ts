import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerAgentRoutes } from '../src/routes/agents.js'
import { updateAgentRecord } from '../src/services/agent-management.js'
import {
  AGENT_TODO_ERROR_CODES,
  AgentTodoError,
  AGENT_MANAGEMENT_ERROR_CODES,
  AgentManagementError,
  archiveAgentTodoTemplate,
  validateTodoTemplateTriggerConfig,
} from '@nessie/workspace-admin'

const dbTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  agentId: string
  avatarAttachmentId: string
  otherAgentId: string
  organizationId: string
  otherOrganizationId: string
  userId: string
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
  const avatarAttachmentId = randomUUID()
  const userId = randomUUID()

  await prisma.organization.createMany({
    data: [
      { id: organizationId, name: `agent-todos-${organizationId}` },
      { id: otherOrganizationId, name: `agent-todos-${otherOrganizationId}` },
    ],
  })
  await prisma.user.create({
    data: {
      displayName: 'Agent to-dos test owner',
      email: `agent-todos-${userId}@example.test`,
      id: userId,
    },
  })
  await prisma.organizationMember.create({
    data: { organizationId, role: 'owner', userId },
  })
  await prisma.attachment.create({
    data: {
      filename: 'agent-todos-avatar.png',
      id: avatarAttachmentId,
      kind: 'image',
      mime: 'image/png',
      organizationId,
      sizeBytes: 1n,
      storageKey: `agent-todos/${avatarAttachmentId}`,
      uploaderId: userId,
    },
  })
  await prisma.agent.createMany({
    data: [
      { id: agentId, name: 'Todo agent', organizationId },
      { id: otherAgentId, name: 'Other todo agent', organizationId },
    ],
  })

  return {
    agentId,
    avatarAttachmentId,
    organizationId,
    otherAgentId,
    otherOrganizationId,
    userId,
  }
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
  await prisma.user.deleteMany({ where: { id: value.userId } })
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

const isTemplateVersionPinViolation = (error: unknown) =>
  error instanceof Error
  && error.message.includes('agent_todos_template_version_pin_chk')

dbTest('POST /api/agents persists todosEnabled through the route', async () => {
  await withDatabase(async (prisma, value) => {
    const actorContext: AuthorizedActionContext = {
      actionContext: { requestId: `agent-todos-create-${value.agentId}` },
      actor: { actorId: value.userId, actorType: 'user', roles: ['owner'] },
      tenant: { organizationId: value.organizationId },
    }
    const app = Fastify({ logger: false })
    registerAgentRoutes(app, {
      config: { model: {} },
      createAgentVisibilityScope: () => ({}),
      getChannelIfMember: async () => null,
      isAgentAccessibleToActor: async () => false,
      prisma,
      requireActorContext: () => actorContext,
      requireOwner: () => true,
    } as unknown as Parameters<typeof registerAgentRoutes>[1])

    try {
      const response = await app.inject({
        method: 'POST',
        payload: {
          avatarAttachmentId: value.avatarAttachmentId,
          name: 'Route-created to-do agent',
          todosEnabled: true,
        },
        url: '/api/agents',
      })

      assert.equal(response.statusCode, 201)
      const created = response.json().data as { id: string; todosEnabled: boolean }
      assert.equal(created.todosEnabled, true)
      const row = await prisma.agent.findUnique({
        select: { todosEnabled: true },
        where: { id: created.id },
      })
      assert.equal(row?.todosEnabled, true)
    } finally {
      await app.close()
    }
  })
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

dbTest('an enabled schedule blocks template archive and disabling to-dos until it is paused', async () => {
  await withDatabase(async (prisma, value) => {
    await prisma.agent.update({ where: { id: value.agentId }, data: { todosEnabled: true } })
    const template = await prisma.agentTodoTemplate.create({
      data: {
        agentId: value.agentId,
        authorType: 'user',
        name: 'Scheduled template',
        organizationId: value.organizationId,
        status: 'active',
        steps: templateSteps,
      },
    })
    const trigger = await prisma.agentTrigger.create({
      data: {
        agentId: value.agentId,
        config: { todoTemplateId: template.id },
        type: 'interval',
      },
    })

    await assert.rejects(
      () => archiveAgentTodoTemplate(prisma, {
        agentId: value.agentId,
        organizationId: value.organizationId,
        templateId: template.id,
      }),
      (error: unknown) => error instanceof AgentTodoError
        && error.code === AGENT_TODO_ERROR_CODES.TEMPLATE_IN_USE,
    )
    await assert.rejects(
      () => updateAgentRecord(prisma, value.agentId, {
        organizationId: value.organizationId,
        todosEnabled: false,
      }),
      (error: unknown) => error instanceof AgentManagementError
        && error.code === AGENT_MANAGEMENT_ERROR_CODES.TODOS_IN_USE,
    )

    await prisma.agentTrigger.update({ where: { id: trigger.id }, data: { enabled: false } })
    const archived = await archiveAgentTodoTemplate(prisma, {
      agentId: value.agentId,
      organizationId: value.organizationId,
      templateId: template.id,
    })
    assert.equal(archived?.status, 'archived')
    const disabled = await updateAgentRecord(prisma, value.agentId, {
      organizationId: value.organizationId,
      todosEnabled: false,
    })
    assert.equal(disabled?.todosEnabled, false)
  })
})

dbTest('scheduled to-do trigger config accepts only this agent\'s active template while to-dos are enabled', async () => {
  await withDatabase(async (prisma, value) => {
    await prisma.agent.update({ where: { id: value.agentId }, data: { todosEnabled: true } })
    const active = await prisma.agentTodoTemplate.create({
      data: {
        agentId: value.agentId,
        authorType: 'user',
        name: 'Active template',
        organizationId: value.organizationId,
        status: 'active',
        steps: templateSteps,
      },
    })
    const foreign = await prisma.agentTodoTemplate.create({
      data: {
        agentId: value.otherAgentId,
        authorType: 'user',
        name: 'Foreign template',
        organizationId: value.organizationId,
        status: 'active',
        steps: templateSteps,
      },
    })
    const archived = await prisma.agentTodoTemplate.create({
      data: {
        agentId: value.agentId,
        authorType: 'user',
        name: 'Archived template',
        organizationId: value.organizationId,
        status: 'archived',
        steps: templateSteps,
      },
    })

    assert.equal(await validateTodoTemplateTriggerConfig(prisma, value.agentId, {
      todoTemplateId: active.id,
    }), true)
    for (const todoTemplateId of [randomUUID(), foreign.id, archived.id]) {
      assert.equal(await validateTodoTemplateTriggerConfig(prisma, value.agentId, {
        todoTemplateId,
      }), false)
    }
    await prisma.agent.update({ where: { id: value.agentId }, data: { todosEnabled: false } })
    assert.equal(await validateTodoTemplateTriggerConfig(prisma, value.agentId, {
      todoTemplateId: active.id,
    }), false)
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
            templateVersion: template.version,
            title: 'Wrong-agent template instance',
          },
        }),
      isForeignKeyViolation,
      'the composite agent/template FK must reject another agent\'s template',
    )
  })
})

dbTest('the database rejects a template to-do without its pinned version', async () => {
  await withDatabase(async (prisma, value) => {
    const template = await prisma.agentTodoTemplate.create({
      data: {
        agentId: value.agentId,
        authorType: 'user',
        name: 'Versioned template',
        organizationId: value.organizationId,
        steps: templateSteps,
      },
    })

    await assert.rejects(
      () =>
        prisma.agentTodo.create({
          data: {
            agentId: value.agentId,
            organizationId: value.organizationId,
            templateId: template.id,
            title: 'Unpinned template instance',
          },
        }),
      isTemplateVersionPinViolation,
      'a template-backed to-do must pin the template version',
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

dbTest('the database rejects duplicate AgentTodo step sequences', async () => {
  await withDatabase(async (prisma, value) => {
    const todo = await prisma.agentTodo.create({
      data: {
        agentId: value.agentId,
        organizationId: value.organizationId,
        title: 'Unique step sequences',
      },
    })

    await prisma.agentTodoStep.create({
      data: {
        instructions: 'Do this first.',
        key: 'first-step',
        sequence: 0,
        title: 'First',
        todoId: todo.id,
      },
    })

    await assert.rejects(
      () =>
        prisma.agentTodoStep.create({
          data: {
            instructions: 'This must not occupy the same position.',
            key: 'second-step',
            sequence: 0,
            title: 'Second',
            todoId: todo.id,
          },
        }),
      isUniqueViolation,
      'the per-to-do sequence constraint must reject duplicate positions',
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
