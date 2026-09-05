import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify, { type FastifyInstance } from 'fastify'

import { registerMailboxRoutes } from '../src/routes/mailbox.js'
import { registerPlanRoutes } from '../src/routes/plans.js'
import { registerToolRoutes } from '../src/routes/tools.js'
import { registerExecutionEnvironmentRoutes } from '../src/routes/execution-environments.js'
import { registerCapabilityRoutes } from '../src/routes/capabilities.js'

/**
 * S2-F4: `mailbox.ts`, `plans.ts`, `tools.ts`, and `execution-environments.ts`
 * used to throw `new Error('SOME_CONSTANT')` and match it back with
 * `error.message === 'SOME_CONSTANT'` — a message string doubling as a code,
 * with no compile-time link between the throw site and the route's match.
 * Each now throws a small typed error class (`MailboxError`, `PlanError`,
 * `ToolRegistryError`, `ExecutionEnvironmentError`) with a `.code`, matched
 * with `instanceof`. This proves the conversion preserved behavior: the same
 * HTTP status and code still come out the route for the same condition.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

type Seed = { channelId: string; organizationId: string; threadId: string; userId: string }

const actorFor = (s: Seed): AuthorizedActionContext => ({
  actionContext: { requestId: `typed-domain-errors-${randomUUID()}` },
  actor: { actorId: s.userId, actorType: 'user', roles: ['owner'] },
  tenant: { organizationId: s.organizationId },
})

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const organization = await prisma.organization.create({
    data: { name: `typed-errors-${randomUUID()}` },
  })
  const project = await prisma.project.create({
    data: { name: 'project', organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: 'team', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'general',
      organizationId: organization.id,
      projectId: project.id,
      slug: `general-${randomUUID()}`,
      teamId: team.id,
      visibility: 'public',
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const user = await prisma.user.create({
    data: { displayName: 'Owner', email: `owner-${randomUUID()}@example.com` },
  })
  return {
    channelId: channel.id,
    organizationId: organization.id,
    threadId: thread.id,
    userId: user.id,
  }
}

const cleanup = async (prisma: PrismaClient, s: Seed): Promise<void> => {
  await prisma.agentMailboxMessage.deleteMany({ where: { organizationId: s.organizationId } })
  await prisma.plan.deleteMany({ where: { organizationId: s.organizationId } })
  await prisma.toolRegistryEntry.deleteMany({ where: { organizationId: s.organizationId } })
  await prisma.executionEnvironmentTemplate.deleteMany({ where: { organizationId: s.organizationId } })
  await prisma.thread.deleteMany({ where: { channelId: s.channelId } })
  await prisma.channel.deleteMany({ where: { organizationId: s.organizationId } })
  const project = await prisma.project.findFirst({ where: { organizationId: s.organizationId } })
  if (project) {
    await prisma.team.deleteMany({ where: { projectId: project.id } })
    await prisma.project.deleteMany({ where: { id: project.id } })
  }
  await prisma.organization.deleteMany({ where: { id: s.organizationId } })
  await prisma.user.deleteMany({ where: { id: s.userId } })
}

const requireOwner = () => true

const buildApp = <T extends (app: FastifyInstance, deps: unknown) => void>(
  register: T,
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
): FastifyInstance => {
  const app = Fastify({ logger: false })
  register(app, {
    prisma,
    requireActorContext: () => actorContext,
    requireOwner,
  })
  return app
}

dbTest('mailbox: a message for a thread outside the org maps to 404 MAILBOX_THREAD_NOT_FOUND', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  const app = buildApp(registerMailboxRoutes, prisma, actorFor(s))
  try {
    const response = await app.inject({
      method: 'POST',
      payload: { body: 'hello', threadId: randomUUID() },
      url: '/api/mailbox',
    })
    assert.equal(response.statusCode, 404)
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      'MAILBOX_THREAD_NOT_FOUND',
    )
  } finally {
    await app.close()
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

dbTest('mailbox: a channelId that does not match the thread maps to 400 MAILBOX_THREAD_CHANNEL_MISMATCH', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  const app = buildApp(registerMailboxRoutes, prisma, actorFor(s))
  try {
    const response = await app.inject({
      method: 'POST',
      payload: { body: 'hello', channelId: randomUUID(), threadId: s.threadId },
      url: '/api/mailbox',
    })
    assert.equal(response.statusCode, 400)
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      'MAILBOX_THREAD_CHANNEL_MISMATCH',
    )
  } finally {
    await app.close()
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

dbTest('tools: an org entry reusing a builtin id maps to 409 BUILTIN_TOOL_ID_RESERVED', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  const app = buildApp(registerToolRoutes, prisma, actorFor(s))
  try {
    const toolId = `reserved-${randomUUID()}`
    await prisma.toolRegistryEntry.create({
      data: {
        builtin: true,
        description: 'builtin',
        enabled: true,
        label: 'Builtin tool',
        organizationId: s.organizationId,
        overview: 'Builtin tool',
        scopeKey: 'builtin',
        toolId,
      },
    })
    const response = await app.inject({
      method: 'POST',
      payload: { description: 'org override attempt', enabled: true, label: 'Org tool', toolId },
      url: '/api/tools/registry',
    })
    assert.equal(response.statusCode, 409)
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      'BUILTIN_TOOL_ID_RESERVED',
    )
  } finally {
    await app.close()
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

dbTest('execution-environments: a channelId outside the org maps to 404 EXECUTION_ENVIRONMENT_CHANNEL_NOT_FOUND', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  const app = buildApp(registerExecutionEnvironmentRoutes, prisma, actorFor(s))
  try {
    const response = await app.inject({
      method: 'POST',
      payload: {
        channelId: randomUUID(),
        mode: 'container',
        name: 'template',
        provider: 'docker',
      },
      url: '/api/execution-environment-templates',
    })
    assert.equal(response.statusCode, 404)
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      'EXECUTION_ENVIRONMENT_CHANNEL_NOT_FOUND',
    )
  } finally {
    await app.close()
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

dbTest('plans: two steps racing for the same sequence leave one PLAN_STEP_SEQUENCE_CONFLICT', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  const app = buildApp(registerPlanRoutes, prisma, actorFor(s))
  try {
    const created = await app.inject({
      method: 'POST',
      payload: { goal: 'Ship the thing' },
      url: '/api/plans',
    })
    assert.equal(created.statusCode, 201, created.body)
    const planId = (created.json() as { data: { id: string } }).data.id

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        payload: { sequence: 0, title: 'Step A', type: 'task' },
        url: `/api/plans/${planId}/steps`,
      }),
      app.inject({
        method: 'POST',
        payload: { sequence: 0, title: 'Step B', type: 'task' },
        url: `/api/plans/${planId}/steps`,
      }),
    ])
    const statuses = [first.statusCode, second.statusCode].sort()
    assert.deepEqual(statuses, [201, 409])
    const conflict = first.statusCode === 409 ? first : second
    assert.equal(
      (conflict.json() as { error: { code: string } }).error.code,
      'PLAN_STEP_SEQUENCE_CONFLICT',
    )
  } finally {
    await app.close()
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

dbTest('capabilities: a session naming no scope maps to 400 TEMP_CONTEXT_SCOPE_REQUIRED', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  const app = buildApp(registerCapabilityRoutes, prisma, actorFor(s))
  try {
    const response = await app.inject({
      method: 'POST',
      payload: { toolIds: ['some_tool'] },
      url: '/api/capabilities/sessions',
    })
    assert.equal(response.statusCode, 400)
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      'TEMP_CONTEXT_SCOPE_REQUIRED',
    )
  } finally {
    await app.close()
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})
