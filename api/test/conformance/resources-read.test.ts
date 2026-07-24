import assert from 'node:assert/strict'
import test from 'node:test'

import { registerProjectRoutes } from '../../src/routes/projects.js'
import { registerTaskRoutes } from '../../src/routes/tasks.js'
import { registerIterationRoutes } from '../../src/routes/iterations.js'
import { registerThreadRoutes } from '../../src/routes/threads.js'
import { registerCommsConnectionRoutes } from '../../src/routes/comms-connections.js'
import { registerWorkflowRoutes } from '../../src/routes/workflows.js'
import { registerMcpRoutes } from '../../src/routes/mcp.js'
import { IDS, foreignOwner, makeApp, seedTenants } from './harness.js'
import type { RouteDeps } from '../../src/routes/types.js'
import { TenantStore } from './tenant-store.js'

/**
 * Canonical cross-tenant READ conformance across the remaining resource areas.
 * Each case seeds an orgA resource and confirms a legitimate orgB owner cannot
 * read it (empty list, or 404 on the by-id route).
 */

test('projects: list is empty and by-id 404s for a foreign org', async () => {
  const store = new TenantStore()
  seedTenants(store)
  store.seed('project', [{ id: IDS.projectA, organizationId: IDS.orgA, name: 'orgA', slug: 'orga' }])
  const app = makeApp(registerProjectRoutes, store, foreignOwner())

  const list = await app.inject({ method: 'GET', url: '/api/projects' })
  assert.equal(list.statusCode, 200)
  assert.deepEqual((list.json() as { data: unknown[] }).data, [])

  const byId = await app.inject({ method: 'GET', url: `/api/projects/${IDS.projectA}` })
  assert.equal(byId.statusCode, 404)
  await app.close()
})

test('tasks: list is empty and by-id 404s for a foreign org', async () => {
  const store = new TenantStore()
  seedTenants(store)
  store.seed('task', [
    {
      id: IDS.taskA,
      organizationId: IDS.orgA,
      projectId: IDS.projectA,
      title: 'orgA task',
      status: 'todo',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    },
  ])
  const app = makeApp(registerTaskRoutes, store, foreignOwner())

  const list = await app.inject({ method: 'GET', url: '/api/tasks' })
  assert.equal(list.statusCode, 200)
  assert.deepEqual((list.json() as { data: unknown[] }).data, [])

  const byId = await app.inject({ method: 'GET', url: `/api/tasks/${IDS.taskA}` })
  assert.equal(byId.statusCode, 404)
  await app.close()
})

test('iterations: a foreign org cannot list another org project\'s iterations', async () => {
  const store = new TenantStore()
  seedTenants(store)
  store.seed('project', [{ id: IDS.projectA, organizationId: IDS.orgA, name: 'orgA', slug: 'orga' }])
  store.seed('iteration', [{ id: IDS.iterationA, organizationId: IDS.orgA, projectId: IDS.projectA }])
  const app = makeApp(registerIterationRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'GET', url: `/api/projects/${IDS.projectA}/iterations` })
  assert.equal(res.statusCode, 404)
  await app.close()
})

test('threads: a foreign org cannot read another org channel\'s messages', async () => {
  const store = new TenantStore()
  seedTenants(store)
  store.seed('channel', [
    { id: IDS.channelA, organizationId: IDS.orgA, visibility: 'public', type: 'standard', systemChannelType: null },
  ])
  store.seed('thread', [{ id: IDS.threadA, channelId: IDS.channelA, title: 'General' }])
  const app = makeApp(registerThreadRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'GET', url: `/api/threads/${IDS.threadA}/messages` })
  assert.equal(res.statusCode, 404)
  await app.close()
})

// Reply threads (#233): every reply-thread surface is gated by the same
// findThreadForUser tenancy check, so a foreign org gets 404 on all of them.
test('threads: a foreign org cannot read or follow another org\'s reply threads', async () => {
  const store = new TenantStore()
  seedTenants(store)
  store.seed('channel', [
    { id: IDS.channelA, organizationId: IDS.orgA, visibility: 'public', type: 'standard', systemChannelType: null },
  ])
  store.seed('thread', [{ id: IDS.threadA, channelId: IDS.channelA, title: 'General' }])
  store.seed('message', [
    { id: IDS.messageA, threadId: IDS.threadA, role: 'user', content: 'orgA root' },
  ])
  const app = makeApp(registerThreadRoutes, store, foreignOwner())

  const listReplies = await app.inject({
    method: 'GET',
    url: `/api/threads/${IDS.threadA}/messages?rootMessageId=${IDS.messageA}`,
  })
  assert.equal(listReplies.statusCode, 404)

  const single = await app.inject({
    method: 'GET',
    url: `/api/threads/${IDS.threadA}/messages/${IDS.messageA}`,
  })
  assert.equal(single.statusCode, 404)

  const follow = await app.inject({
    method: 'PUT',
    url: `/api/threads/${IDS.threadA}/messages/${IDS.messageA}/follow`,
    payload: { following: true },
  })
  assert.equal(follow.statusCode, 404)

  const reply = await app.inject({
    method: 'POST',
    url: `/api/threads/${IDS.threadA}/messages`,
    payload: { content: 'cross-tenant reply attempt', rootMessageId: IDS.messageA },
  })
  assert.equal(reply.statusCode, 404)
  await app.close()
})

test('comms connections: list is scoped to the caller\'s org + user', async () => {
  const store = new TenantStore()
  seedTenants(store)
  store.seed('commsConnection', [
    {
      id: IDS.connectionA,
      organizationId: IDS.orgA,
      ownerUserId: IDS.userA,
      provider: 'slack',
      status: 'connected',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    },
  ])
  const app = makeApp(registerCommsConnectionRoutes, store, foreignOwner())

  const list = await app.inject({ method: 'GET', url: '/api/comms/connections' })
  assert.equal(list.statusCode, 200)
  assert.deepEqual((list.json() as { data: { connections: unknown[] } }).data.connections, [])

  const byId = await app.inject({ method: 'GET', url: `/api/comms/connections/${IDS.connectionA}` })
  assert.equal(byId.statusCode, 404)
  await app.close()
})

test('workflow installations: list is empty for a foreign org', async () => {
  const store = new TenantStore()
  seedTenants(store)
  store.seed('workflowInstallation', [
    { id: IDS.workflowInstallA, organizationId: IDS.orgA, templateId: 'tpl', status: 'active' },
  ])
  const app = makeApp(registerWorkflowRoutes, store, foreignOwner())

  const res = await app.inject({ method: 'GET', url: '/api/workflow-installations' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual((res.json() as { data: unknown[] }).data, [])
  await app.close()
})

test('mcp instances: list is empty for a foreign org', async () => {
  const store = new TenantStore()
  seedTenants(store)
  store.seed('mcpServerInstance', [
    {
      id: IDS.mcpInstanceA,
      organizationId: IDS.orgA,
      scopeType: 'organization',
      scopeId: IDS.orgA,
      status: 'active',
    },
  ])
  // registerMcpRoutes takes a bespoke deps shape (not RouteDeps); the encrypted
  // secret stores are unused by the org-scoped list read, so they stay omitted.
  const app = makeApp(
    (instance, deps: RouteDeps) =>
      registerMcpRoutes(instance, {
        prisma: deps.prisma,
        requireActorContext: deps.requireActorContext,
        requireOwner: deps.requireOwner,
      } as unknown as Parameters<typeof registerMcpRoutes>[1]),
    store,
    foreignOwner(),
  )

  const res = await app.inject({ method: 'GET', url: '/api/mcp/instances' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual((res.json() as { data: unknown[] }).data, [])
  await app.close()
})
