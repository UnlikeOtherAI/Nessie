import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type { AgentTodoTemplateRecord } from '@nessie/schemas'

import {
  activeTemplatePayload,
  cleanupAgentTodoRoutes,
  createAgentTodoRouteApp,
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

/**
 * The template PUT route (`api/src/routes/agent-todos.ts`) is wired through
 * `lib/if-match.ts` the same way `routes/dashboards.ts` is: a caller can state
 * the revision it edited via the `If-Match` header, a stale one is refused
 * with a 409 revision-conflict envelope, and a malformed one is refused with
 * the shared 400 `INVALID_IF_MATCH`. `body.version` remains the fallback for
 * a caller that has not moved to the header.
 */
dbTest('PUT todo-template refuses a stale If-Match with a revision conflict', async () => {
  await withDatabase(async (prisma, seed) => {
    const app = createAgentTodoRouteApp(prisma, seed, 'owner')
    try {
      const created = await app.inject({
        method: 'POST',
        payload: activeTemplatePayload,
        url: `/api/agents/${seed.agentId}/todo-templates`,
      })
      assert.equal(created.statusCode, 201)
      const template = (created.json() as { data: AgentTodoTemplateRecord }).data

      const staleEdit = await app.inject({
        headers: { 'if-match': String(template.version) },
        method: 'PUT',
        payload: { name: 'First edit', version: template.version },
        url: `/api/agents/${seed.agentId}/todo-templates/${template.id}`,
      })
      assert.equal(staleEdit.statusCode, 200)

      // Retrying with the same (now stale) revision must be refused, not
      // silently overwrite the edit that just landed.
      const conflict = await app.inject({
        headers: { 'if-match': String(template.version) },
        method: 'PUT',
        payload: { name: 'Second edit', version: template.version },
        url: `/api/agents/${seed.agentId}/todo-templates/${template.id}`,
      })
      assert.equal(conflict.statusCode, 409)
      const body = conflict.json() as {
        error: { code: string; details?: { currentRevision?: number } }
      }
      assert.equal(body.error.code, 'AGENT_TODO_TEMPLATE_CHANGED')
      assert.equal(body.error.details?.currentRevision, template.version + 1)
    } finally {
      await app.close()
    }
  })
})

dbTest('PUT todo-template refuses a malformed If-Match header', async () => {
  await withDatabase(async (prisma, seed) => {
    const app = createAgentTodoRouteApp(prisma, seed, 'owner')
    try {
      const created = await app.inject({
        method: 'POST',
        payload: activeTemplatePayload,
        url: `/api/agents/${seed.agentId}/todo-templates`,
      })
      assert.equal(created.statusCode, 201)
      const template = (created.json() as { data: AgentTodoTemplateRecord }).data

      const response = await app.inject({
        headers: { 'if-match': 'not-a-revision' },
        method: 'PUT',
        payload: { name: 'Edited', version: template.version },
        url: `/api/agents/${seed.agentId}/todo-templates/${template.id}`,
      })
      assert.equal(response.statusCode, 400)
      assert.equal(
        (response.json() as { error: { code: string } }).error.code,
        'INVALID_IF_MATCH',
      )
    } finally {
      await app.close()
    }
  })
})

dbTest('PUT todo-template without If-Match falls back to body.version', async () => {
  await withDatabase(async (prisma, seed) => {
    const app = createAgentTodoRouteApp(prisma, seed, 'owner')
    try {
      const created = await app.inject({
        method: 'POST',
        payload: activeTemplatePayload,
        url: `/api/agents/${seed.agentId}/todo-templates`,
      })
      assert.equal(created.statusCode, 201)
      const template = (created.json() as { data: AgentTodoTemplateRecord }).data

      const response = await app.inject({
        method: 'PUT',
        payload: { name: 'No header edit', version: template.version },
        url: `/api/agents/${seed.agentId}/todo-templates/${template.id}`,
      })
      assert.equal(response.statusCode, 200)
      const edited = (response.json() as { data: AgentTodoTemplateRecord }).data
      assert.equal(edited.version, template.version + 1)
      assert.equal(edited.name, 'No header edit')
    } finally {
      await app.close()
    }
  })
})
