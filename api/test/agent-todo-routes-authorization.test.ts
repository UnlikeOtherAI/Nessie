import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type { AgentTodoRecord, AgentTodoTemplateRecord } from '@nessie/schemas'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'

import {
  activeTemplatePayload,
  cleanupAgentTodoRoutes,
  createAgentTodoRouteApp,
  seedAgentTodoRoutes,
  type AgentTodoRouteSeed,
} from './agent-todo-route-fixture.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

const responseData = <T>(response: LightMyRequestResponse): T =>
  (response.json() as { data: T }).data

const responseErrorCode = (response: LightMyRequestResponse): string | undefined =>
  (response.json() as { error?: { code?: string } }).error?.code

const withDatabase = async (
  run: (prisma: PrismaClient, seed: AgentTodoRouteSeed) => Promise<void>,
): Promise<void> => {
  const prisma = new PrismaClient()
  let seed: AgentTodoRouteSeed | undefined
  try {
    seed = await seedAgentTodoRoutes(prisma)
    await run(prisma, seed)
  } finally {
    if (seed) await cleanupAgentTodoRoutes(prisma, seed)
    await prisma.$disconnect()
  }
}

const closeApps = async (...apps: FastifyInstance[]): Promise<void> => {
  await Promise.all(apps.map((app) => app.close()))
}

dbTest('a bound channel member can list an agent templates and instances', async () => {
  await withDatabase(async (prisma, seed) => {
    const ownerApp = createAgentTodoRouteApp(prisma, seed, 'owner')
    const memberApp = createAgentTodoRouteApp(prisma, seed, 'member')
    try {
      const createdTemplate = await ownerApp.inject({
        method: 'POST',
        payload: activeTemplatePayload,
        url: `/api/agents/${seed.agentId}/todo-templates`,
      })
      assert.equal(createdTemplate.statusCode, 201)
      const template = responseData<AgentTodoTemplateRecord>(createdTemplate)
      const createdTodo = await memberApp.inject({
        method: 'POST',
        payload: { templateId: template.id },
        url: `/api/agents/${seed.agentId}/todos`,
      })
      assert.equal(createdTodo.statusCode, 201)

      const templates = await memberApp.inject({
        method: 'GET',
        url: `/api/agents/${seed.agentId}/todo-templates`,
      })
      const todos = await memberApp.inject({
        method: 'GET',
        url: `/api/agents/${seed.agentId}/todos`,
      })

      assert.equal(templates.statusCode, 200)
      assert.deepEqual(
        responseData<AgentTodoTemplateRecord[]>(templates).map((item) => item.id),
        [template.id],
      )
      assert.equal(todos.statusCode, 200)
      assert.equal(responseData<AgentTodoRecord[]>(todos).length, 1)

      const archived = await ownerApp.inject({
        method: 'POST',
        payload: {},
        url: `/api/agents/${seed.agentId}/todo-templates/${template.id}/archive`,
      })
      assert.equal(archived.statusCode, 200)
      const defaultTemplates = await memberApp.inject({
        method: 'GET',
        url: `/api/agents/${seed.agentId}/todo-templates`,
      })
      const allTemplates = await memberApp.inject({
        method: 'GET',
        url: `/api/agents/${seed.agentId}/todo-templates?includeArchived=true`,
      })
      assert.deepEqual(responseData<AgentTodoTemplateRecord[]>(defaultTemplates), [])
      assert.deepEqual(
        responseData<AgentTodoTemplateRecord[]>(allTemplates).map((item) => item.id),
        [template.id],
      )
    } finally {
      await closeApps(ownerApp, memberApp)
    }
  })
})

dbTest('to-do thread and run links are withheld from a viewer outside that thread', async () => {
  await withDatabase(async (prisma, seed) => {
    const ownerApp = createAgentTodoRouteApp(prisma, seed, 'owner')
    const memberApp = createAgentTodoRouteApp(prisma, seed, 'member')
    try {
      const alternateChannelId = randomUUID()
      await prisma.channel.create({
        data: {
          id: alternateChannelId,
          label: 'agent-todo-alternate-channel',
          organizationId: seed.organizationId,
          projectId: seed.projectId,
          slug: `agent-todo-alternate-${alternateChannelId.slice(0, 8)}`,
          teamId: seed.teamId,
          visibility: 'private',
          members: { create: { userId: seed.memberId } },
        },
      })
      await prisma.agentBinding.create({
        data: { agentId: seed.agentId, channelId: alternateChannelId },
      })
      await prisma.channelMember.delete({
        where: {
          channelId_userId: { channelId: seed.channelId, userId: seed.memberId },
        },
      })

      const created = await memberApp.inject({
        method: 'POST',
        payload: {
          steps: [{ instructions: 'Keep working.', key: 'work', title: 'Work' }],
          title: 'Linked checklist',
        },
        url: `/api/agents/${seed.agentId}/todos`,
      })
      assert.equal(created.statusCode, 201)
      const todo = responseData<AgentTodoRecord>(created)
      const run = await prisma.run.create({
        data: { agentId: seed.agentId, status: 'running', threadId: seed.threadId },
      })
      await prisma.agentTodo.update({
        data: { activeRunId: run.id, threadId: seed.threadId },
        where: { id: todo.id },
      })

      const hiddenResponse = await memberApp.inject({
        method: 'GET',
        url: `/api/agents/${seed.agentId}/todos/${todo.id}`,
      })
      assert.equal(hiddenResponse.statusCode, 200)
      const hidden = responseData<AgentTodoRecord>(hiddenResponse)
      assert.equal(hidden.threadId, null)
      assert.equal(hidden.activeRunId, null)

      const hiddenList = await memberApp.inject({
        method: 'GET',
        url: `/api/agents/${seed.agentId}/todos`,
      })
      assert.equal(responseData<AgentTodoRecord[]>(hiddenList)[0]?.threadId, null)

      const visibleResponse = await ownerApp.inject({
        method: 'GET',
        url: `/api/agents/${seed.agentId}/todos/${todo.id}`,
      })
      assert.equal(visibleResponse.statusCode, 200)
      const visible = responseData<AgentTodoRecord>(visibleResponse)
      assert.equal(visible.threadId, seed.threadId)
      assert.equal(visible.activeRunId, run.id)
    } finally {
      await closeApps(ownerApp, memberApp)
    }
  })
})

dbTest('an actor with no path to the agent gets AGENT_NOT_FOUND on every route', async () => {
  await withDatabase(async (prisma, seed) => {
    const app = createAgentTodoRouteApp(prisma, seed, 'outsider')
    const templateId = randomUUID()
    const todoId = randomUUID()
    const routes = [
      { method: 'GET' as const, url: `/api/agents/${seed.agentId}/todo-templates` },
      {
        method: 'POST' as const,
        payload: activeTemplatePayload,
        url: `/api/agents/${seed.agentId}/todo-templates`,
      },
      {
        method: 'PUT' as const,
        payload: { name: 'Hidden update' },
        url: `/api/agents/${seed.agentId}/todo-templates/${templateId}`,
      },
      {
        method: 'POST' as const,
        payload: {},
        url: `/api/agents/${seed.agentId}/todo-templates/${templateId}/archive`,
      },
      { method: 'GET' as const, url: `/api/agents/${seed.agentId}/todos` },
      {
        method: 'POST' as const,
        payload: { templateId },
        url: `/api/agents/${seed.agentId}/todos`,
      },
      { method: 'GET' as const, url: `/api/agents/${seed.agentId}/todos/${todoId}` },
      {
        method: 'POST' as const,
        payload: { status: 'completed' },
        url: `/api/agents/${seed.agentId}/todos/${todoId}/steps/hidden-step`,
      },
      {
        method: 'POST' as const,
        payload: {},
        url: `/api/agents/${seed.agentId}/todos/${todoId}/cancel`,
      },
    ]

    try {
      for (const route of routes) {
        const response = await app.inject(route)
        assert.equal(response.statusCode, 404, `${route.method} ${route.url}`)
        assert.equal(responseErrorCode(response), 'AGENT_NOT_FOUND', route.url)
      }
    } finally {
      await app.close()
    }
  })
})

dbTest('todosEnabled false returns AGENT_TODOS_DISABLED on every route', async () => {
  await withDatabase(async (prisma, seed) => {
    const app = createAgentTodoRouteApp(prisma, seed, 'owner')
    const templateId = randomUUID()
    const todoId = randomUUID()
    const prefix = `/api/agents/${seed.disabledAgentId}`
    const routes = [
      { method: 'GET' as const, url: `${prefix}/todo-templates` },
      { method: 'POST' as const, payload: activeTemplatePayload, url: `${prefix}/todo-templates` },
      {
        method: 'PUT' as const,
        payload: { name: 'Disabled update' },
        url: `${prefix}/todo-templates/${templateId}`,
      },
      {
        method: 'POST' as const,
        payload: {},
        url: `${prefix}/todo-templates/${templateId}/archive`,
      },
      { method: 'GET' as const, url: `${prefix}/todos` },
      { method: 'POST' as const, payload: { templateId }, url: `${prefix}/todos` },
      { method: 'GET' as const, url: `${prefix}/todos/${todoId}` },
      {
        method: 'POST' as const,
        payload: { status: 'completed' },
        url: `${prefix}/todos/${todoId}/steps/disabled-step`,
      },
      { method: 'POST' as const, payload: {}, url: `${prefix}/todos/${todoId}/cancel` },
    ]

    try {
      for (const route of routes) {
        const response = await app.inject(route)
        assert.equal(response.statusCode, 409, `${route.method} ${route.url}`)
        assert.equal(responseErrorCode(response), 'AGENT_TODOS_DISABLED', route.url)
      }
    } finally {
      await app.close()
    }
  })
})

dbTest('template writes are owner-only while members can create and tick instances', async () => {
  await withDatabase(async (prisma, seed) => {
    const ownerApp = createAgentTodoRouteApp(prisma, seed, 'owner')
    const memberApp = createAgentTodoRouteApp(prisma, seed, 'member')
    try {
      const ownerCreate = await ownerApp.inject({
        method: 'POST',
        payload: activeTemplatePayload,
        url: `/api/agents/${seed.agentId}/todo-templates`,
      })
      assert.equal(ownerCreate.statusCode, 201)
      const template = responseData<AgentTodoTemplateRecord>(ownerCreate)

      const deniedWrites = [
        {
          method: 'POST' as const,
          payload: activeTemplatePayload,
          url: `/api/agents/${seed.agentId}/todo-templates`,
        },
        {
          method: 'PUT' as const,
          payload: { name: 'Member rewrite' },
          url: `/api/agents/${seed.agentId}/todo-templates/${template.id}`,
        },
        {
          method: 'POST' as const,
          payload: {},
          url: `/api/agents/${seed.agentId}/todo-templates/${template.id}/archive`,
        },
      ]
      for (const route of deniedWrites) {
        const response = await memberApp.inject(route)
        assert.equal(response.statusCode, 403, route.url)
        assert.equal(responseErrorCode(response), 'FORBIDDEN', route.url)
      }

      const created = await memberApp.inject({
        method: 'POST',
        payload: { templateId: template.id },
        url: `/api/agents/${seed.agentId}/todos`,
      })
      assert.equal(created.statusCode, 201)
      const todo = responseData<AgentTodoRecord>(created)
      const ticked = await memberApp.inject({
        method: 'POST',
        payload: { note: 'Evidence collected.', status: 'completed' },
        url: `/api/agents/${seed.agentId}/todos/${todo.id}/steps/collect-evidence`,
      })
      assert.equal(ticked.statusCode, 200)
      const current = responseData<AgentTodoRecord>(ticked)
      assert.equal(current.steps[0]?.status, 'completed')
      assert.equal(current.steps[0]?.updatedByActorType, 'user')
      assert.equal(current.steps[0]?.updatedByActorId, seed.memberId)
    } finally {
      await closeApps(ownerApp, memberApp)
    }
  })
})

dbTest('a non-creator member gets a reason-coded refusal for tick and cancel', async () => {
  await withDatabase(async (prisma, seed) => {
    const memberApp = createAgentTodoRouteApp(prisma, seed, 'member')
    const peerApp = createAgentTodoRouteApp(prisma, seed, 'peer')
    try {
      const created = await memberApp.inject({
        method: 'POST',
        payload: {
          steps: [{ key: 'owned-step', title: 'Owned step', instructions: 'Do it.' }],
          title: 'Member-owned checklist',
        },
        url: `/api/agents/${seed.agentId}/todos`,
      })
      assert.equal(created.statusCode, 201)
      const todo = responseData<AgentTodoRecord>(created)

      for (const route of [
        {
          method: 'POST' as const,
          payload: { status: 'completed' },
          url: `/api/agents/${seed.agentId}/todos/${todo.id}/steps/owned-step`,
        },
        {
          method: 'POST' as const,
          payload: {},
          url: `/api/agents/${seed.agentId}/todos/${todo.id}/cancel`,
        },
      ]) {
        const response = await peerApp.inject(route)
        assert.equal(response.statusCode, 403)
        assert.equal(responseErrorCode(response), 'AGENT_TODO_ACTION_FORBIDDEN')
      }
    } finally {
      await closeApps(memberApp, peerApp)
    }
  })
})
