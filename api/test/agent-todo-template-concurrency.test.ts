import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  AGENT_TODO_ERROR_CODES,
  AgentTodoError,
  createAgentTodoTemplate,
  updateAgentTodoTemplate,
} from '@nessie/team-admin'

import {
  cleanupAgentTodoRoutes,
  seedAgentTodoRoutes,
  type AgentTodoRouteSeed,
} from './agent-todo-route-fixture.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

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

dbTest('concurrent template edits refuse the stale writer', async () => {
  await withDatabase(async (prisma, seed) => {
    const template = await createAgentTodoTemplate(prisma, {
      agentId: seed.agentId,
      authorType: 'user',
      createdByUserId: seed.ownerId,
      name: 'Concurrent edits',
      organizationId: seed.organizationId,
      proposedByRunId: null,
      status: 'draft',
      steps: [{ instructions: 'Start here.', key: 'start', title: 'Start' }],
    })
    const results = await Promise.allSettled([
      updateAgentTodoTemplate(prisma, {
        agentId: seed.agentId,
        createdByUserId: seed.ownerId,
        name: 'First edit',
        organizationId: seed.organizationId,
        templateId: template.id,
        version: template.version,
      }),
      updateAgentTodoTemplate(prisma, {
        agentId: seed.agentId,
        createdByUserId: seed.ownerId,
        name: 'Second edit',
        organizationId: seed.organizationId,
        templateId: template.id,
        version: template.version,
      }),
    ])

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = results.find((result) => result.status === 'rejected')
    assert.equal(rejected?.status, 'rejected')
    if (rejected?.status !== 'rejected') return
    assert.ok(rejected.reason instanceof AgentTodoError)
    assert.equal(rejected.reason.code, AGENT_TODO_ERROR_CODES.TEMPLATE_CHANGED)
    assert.equal(
      (await prisma.agentTodoTemplate.findUnique({ where: { id: template.id } }))?.version,
      template.version + 1,
    )
  })
})
