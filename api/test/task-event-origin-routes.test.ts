import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import {
  AuthorizedActionContextSchema,
  ColumnEnteredTaskEventPayloadSchema,
  CreatedTaskEventPayloadSchema,
  PriorityChangedTaskEventPayloadSchema,
} from '@nessie/schemas'
import { listAccessibleProjectIds } from '@nessie/team-admin'

import { registerGlobalAuthHook } from '../src/lib/global-auth-hook.js'
import { taskEventOriginFor } from '../src/lib/task-event-origin.js'
import { nessieMcpTools } from '../src/mcp/server.js'
import type { McpToolContext } from '../src/mcp/tool-context.js'
import { registerTaskRoutes } from '../src/routes/tasks.js'
import type { RouteDeps } from '../src/routes/types.js'
import { mintAgentAccessCredential } from '../src/services/mcp-agent/agent-credential.js'
import { getTask } from '../src/services/tasks.js'

/**
 * A ticket change's origin is the credential the global auth hook verified,
 * never the caller's claim: only a person's own session is `session`, the MCP
 * surface's agent credential is `token`, and anything the hook did not
 * authenticate is `system` (docs/standards/ticket-work.md). Only a `session`
 * event can start or steer an agent's ticket work, so each door is pinned.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

test('only a verified session is a session; a credential is a token naming itself', () => {
  assert.deepEqual(taskEventOriginFor({ authenticatedWith: 'session' }), { kind: 'session' })
  assert.deepEqual(
    taskEventOriginFor({ agentCredential: { id: 'cred-1' } as never }),
    { kind: 'token', keyId: 'cred-1' },
  )
  assert.deepEqual(
    taskEventOriginFor({ voiceCredential: { id: 'voice-1' } as never }),
    { kind: 'token', keyId: 'voice-1' },
  )
  // A credential outranks a stray session flag: it is never a person at a screen.
  assert.deepEqual(
    taskEventOriginFor({ authenticatedWith: 'session', agentCredential: { id: 'cred-2' } as never }),
    { kind: 'token', keyId: 'cred-2' },
  )
  assert.deepEqual(taskEventOriginFor({}), { kind: 'system' })
})

const seed = async (prisma: PrismaClient) => {
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Mover', email: `origin-route-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `origin-route-${suffix}` } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: user.id, role: 'member' },
  })
  const project = await prisma.project.create({ data: { name: `p-${suffix}`, organizationId: organization.id } })
  await prisma.projectMember.create({ data: { projectId: project.id, userId: user.id, role: 'member' } })
  const board = await prisma.board.create({
    data: { projectId: project.id, organizationId: organization.id, name: 'Board', isDefault: true, position: 0 },
  })
  const [todo, inProgress] = await Promise.all([
    prisma.boardColumn.create({
      data: { boardId: board.id, organizationId: organization.id, name: 'To do', category: 'todo', position: 0 },
    }),
    prisma.boardColumn.create({
      data: {
        boardId: board.id, organizationId: organization.id, name: 'In progress', category: 'in_progress', position: 1,
      },
    }),
  ])
  const actorContext = AuthorizedActionContextSchema.parse({
    actionContext: { requestId: randomUUID() },
    actor: { actorId: user.id, actorType: 'user', roles: ['member'] },
    tenant: { organizationId: organization.id, projectId: project.id },
  })
  return {
    organizationId: organization.id,
    projectId: project.id,
    userId: user.id,
    columns: { todo: todo.id, inProgress: inProgress.id },
    actorContext,
    cleanup: async () => {
      await prisma.organization.deleteMany({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: user.id } })
    },
  }
}
type Seed = Awaited<ReturnType<typeof seed>>

/**
 * The real global hook in front of the real task routes. The session verifier
 * is a stand-in that admits `Bearer session` as the seed's person, as the
 * production verifier admits a signed session token; the agent credential is
 * a real minted one, verified by the hook's own verifier.
 */
const buildApp = async (prisma: PrismaClient, s: Seed) => {
  const app = Fastify({ logger: false })
  registerGlobalAuthHook(app, {
    authenticateRequest: (async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.headers.authorization !== 'Bearer session') {
        reply.code(401).send({ error: { code: 'AUTH_REQUIRED' } })
        return null
      }
      request.actorContext = s.actorContext
      return { actorContext: s.actorContext }
    }) as never,
    config: { api: { rateLimit: {} } } as never,
    rateLimiter: { guard: async () => ({ allowed: true }) } as never,
    prisma,
  })
  // What each door stamps, read straight off the request the hook admitted.
  app.post('/test/origin', { config: { agentCredential: true } }, async (request) => taskEventOriginFor(request))
  registerTaskRoutes(app, {
    prisma,
    encryptionKeyRing: {},
    requireActorContext: (request: FastifyRequest) => request.actorContext,
    requireUserActor: () => true,
    listAccessibleProjectIds: async () =>
      listAccessibleProjectIds(prisma, {
        isOrganizationAdmin: false,
        organizationId: s.organizationId,
        userId: s.userId,
      }),
    realtimeHub: { publishWs: async () => undefined },
  } as unknown as RouteDeps)
  await app.ready()
  return app
}

const eventsOf = (prisma: PrismaClient, taskId: string, eventType: string) =>
  prisma.taskEvent.findMany({ where: { taskId, eventType }, orderBy: { createdAt: 'asc' } })

runDatabaseTest('the hook stamps a session only for a session, and a credential as its own token', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  const app = await buildApp(prisma, s)
  t.after(async () => { await app.close(); await s.cleanup(); await prisma.$disconnect() })

  const session = await app.inject({ method: 'POST', url: '/test/origin', headers: { authorization: 'Bearer session' } })
  assert.deepEqual(session.json(), { kind: 'session' })

  const { credential, token } = await mintAgentAccessCredential(prisma, {
    label: 'Claude Code',
    organizationId: s.organizationId,
    projectId: s.projectId,
    scopes: ['boards_write'],
    teamId: null,
    userId: s.userId,
  })
  const minted = await app.inject({ method: 'POST', url: '/test/origin', headers: { authorization: `Bearer ${token}` } })
  assert.deepEqual(minted.json(), { kind: 'token', keyId: credential.id })
})

runDatabaseTest('a person\'s own session stamps session on create, move and priority', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  const app = await buildApp(prisma, s)
  t.after(async () => { await app.close(); await s.cleanup(); await prisma.$disconnect() })
  const headers = { authorization: 'Bearer session' }

  const created = await app.inject({
    method: 'POST', url: '/api/tasks', headers, payload: { projectId: s.projectId, title: 'Fix login redirect' },
  })
  assert.equal(created.statusCode, 201, created.body)
  const taskId = (created.json() as { data: { id: string } }).data.id
  const [createdEvent] = await eventsOf(prisma, taskId, 'created')
  assert.deepEqual(CreatedTaskEventPayloadSchema.parse(createdEvent?.payload).origin, { kind: 'session' })

  const moved = await app.inject({
    method: 'POST', url: `/api/tasks/${taskId}/move`, headers, payload: { columnId: s.columns.inProgress },
  })
  assert.equal(moved.statusCode, 200, moved.body)
  const [entered] = await eventsOf(prisma, taskId, 'column_entered')
  assert.deepEqual(ColumnEnteredTaskEventPayloadSchema.parse(entered?.payload), {
    by: s.userId, origin: { kind: 'session' }, fromColumnId: s.columns.todo, toColumnId: s.columns.inProgress,
  })

  const edited = await app.inject({
    method: 'PATCH', url: `/api/tasks/${taskId}`, headers, payload: { priority: 'urgent' },
  })
  assert.equal(edited.statusCode, 200, edited.body)
  const [priority] = await eventsOf(prisma, taskId, 'priority_changed')
  assert.deepEqual(PriorityChangedTaskEventPayloadSchema.parse(priority?.payload).origin, { kind: 'session' })
})

runDatabaseTest('the MCP surface stamps its credential as a token on create, move and update', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const origin = { kind: 'token', keyId: randomUUID() } as const
  const context: McpToolContext = {
    actorContext: s.actorContext,
    encryptionKeyRing: { activeVersion: 'test', keys: { test: 'mcp-origin-encryption-root' } },
    checkPolicy: async () => ({ allowed: true, reasonCode: 'ALLOWED' }),
    getTask: async (taskId) => getTask(prisma, taskId, s.organizationId, undefined, s.userId, undefined) as never,
    isProjectAccessibleToActor: async () => true,
    knowledge: null,
    prisma,
    scopes: ['boards_read', 'boards_write'],
    spreadsheet: null,
    taskEventOrigin: origin,
  }
  const tool = (name: string) => nessieMcpTools().find((candidate) => candidate.name === name)!

  const created = await tool('nessie_task_create').run(context, {
    projectId: s.projectId, title: 'From Claude Code',
  }) as { task: { id: string } }
  await tool('nessie_task_move').run(context, { taskId: created.task.id, columnId: s.columns.inProgress })
  await tool('nessie_task_update').run(context, { taskId: created.task.id, priority: 'high' })

  const [createdEvent] = await eventsOf(prisma, created.task.id, 'created')
  assert.deepEqual(CreatedTaskEventPayloadSchema.parse(createdEvent?.payload).origin, origin)
  const [entered] = await eventsOf(prisma, created.task.id, 'column_entered')
  assert.deepEqual(ColumnEnteredTaskEventPayloadSchema.parse(entered?.payload).origin, origin)
  const [priority] = await eventsOf(prisma, created.task.id, 'priority_changed')
  assert.deepEqual(PriorityChangedTaskEventPayloadSchema.parse(priority?.payload).origin, origin)
})
