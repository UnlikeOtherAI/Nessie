import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { executorCodingSessionOwnerKey } from '@nessie/executor-manage'
import { AuthorizedActionContextSchema, ticketWorkCodingSessionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { createRequestHelpers } from '../src/lib/request-helpers.js'
import { registerExecutorRoutes } from '../src/routes/executors.js'
import { registerStandingPolicyViewRoutes } from '../src/routes/standing-policy-views.js'
import { registerTriggerMachineAccessRoutes } from '../src/routes/trigger-machine-access.js'
import type { RouteDeps } from '../src/routes/types.js'
import { PASSWORD, seedStandingPolicyRoutes as seed } from './standing-policy-routes-fixture.js'

/**
 * A ticket trigger's machine access through its routes, over a real database
 * (docs/standards/ticket-work.md): prepared from the trigger's Machine access
 * section by its author alone, each machine that cannot take the work named
 * with its reason, and confirmed through the executor access-change door with
 * the author's password — which applies the assignment, the grant and the
 * policy in one step.
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip


runDatabaseTest('the author prepares machine access from the trigger and confirms it with their password', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const s = await seed(prisma, suffix)
  t.after(async () => {
    await prisma.executorContinuation.deleteMany({ where: { executorId: { in: [s.minis, s.bare] } } })
    await prisma.executorPrivateAssignment.deleteMany({ where: { executorId: { in: [s.minis, s.bare] } } })
    await prisma.executorAgentOperationGrant.deleteMany({ where: { executorId: { in: [s.minis, s.bare] } } })
    await prisma.executorStandingPolicy.deleteMany({ where: { organizationId: s.organizationId } })
    await prisma.executor.deleteMany({ where: { id: { in: [s.minis, s.bare] } } })
    await prisma.organization.deleteMany({ where: { id: s.organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [s.authorId, s.colleagueId] } } })
    await prisma.$disconnect()
  })

  let actorId = s.colleagueId
  const deps = {
    buildChannelRealtimeScopes: createRequestHelpers(prisma).buildChannelRealtimeScopes,
    config: { api: { rateLimit: {} } },
    encryptionKeyRing: `standing-routes-${suffix}`,
    prisma,
    rateLimiter: { guard: async () => ({ allowed: true }) },
    realtimeHub: { publishWs: async (_scopes: unknown[], input: Record<string, unknown>) => ({ ...input, type: 'event' }) },
    requireActorContext: () => AuthorizedActionContextSchema.parse({
      actionContext: { requestId: randomUUID() },
      actor: { actorId, actorType: 'user', roles: ['member'] },
      tenant: { organizationId: s.organizationId, teamId: s.teamId },
    }),
    requireUserActor: () => true,
  } as unknown as RouteDeps
  const app = Fastify()
  registerTriggerMachineAccessRoutes(app, deps)
  registerExecutorRoutes(app, deps)
  t.after(() => app.close())
  const prepare = (payload: Record<string, unknown>) => app.inject({
    method: 'POST', payload, url: `/api/triggers/${s.triggerId}/machine-access`,
  })

  // A colleague on the project is not the author: they learn nothing about the author's machines.
  const byColleague = await prepare({ executorIds: [s.minis] })
  assert.equal(byColleague.statusCode, 400, byColleague.body)
  const refused = JSON.parse(byColleague.body) as { error: { code: string; details?: unknown; message: string } }
  assert.equal(refused.error.code, 'MACHINE_ACCESS_REFUSED')
  assert.match(refused.error.message, /Only Ondrej, who set this trigger up/)
  assert.equal(refused.error.details, undefined)

  actorId = s.authorId
  const withBare = await prepare({ executorIds: [s.minis, s.bare] })
  assert.equal(withBare.statusCode, 400, withBare.body)
  type MachineRefusal = { error: { details: { machines: Array<{ label: string; reason: string }> } } }
  const machineRefusal = JSON.parse(withBare.body) as MachineRefusal
  assert.deepEqual(machineRefusal.error.details.machines.map((machine) => [machine.label, machine.reason]), [
    ['Bare', 'no_reviewed_coding_sessions'],
  ])

  const prepared = await prepare({ executorIds: [s.minis], limits: { ticketUsd: 10 } })
  assert.equal(prepared.statusCode, 201, prepared.body)
  const body = JSON.parse(prepared.body) as {
    data: { accessChangeId: string; card: { title: string }; confirmationToken: string; policyId: string }
  }
  assert.equal(body.data.card.title, 'Let CTO use Minis')
  const review = await app.inject({ method: 'GET', url: `/api/executor-access-changes/${body.data.accessChangeId}` })
  assert.equal(review.statusCode, 200, review.body)
  const change = JSON.parse(review.body) as {
    data: { change: { kind: string; summary: unknown }; requiresFreshVerification: boolean; verificationMethod: string }
  }
  assert.equal(change.data.change.kind, 'standing_policy')
  assert.deepEqual(change.data.change.summary, { machineLabels: ['Minis'], triggerName: 'Pick up tickets' })
  assert.equal(change.data.requiresFreshVerification, true)
  assert.equal(change.data.verificationMethod, 'password')

  const confirm = (currentPassword: string) => app.inject({
    method: 'POST',
    payload: { confirmationToken: body.data.confirmationToken, currentPassword },
    url: `/api/executor-access-changes/${body.data.accessChangeId}/confirm`,
  })
  const wrong = await confirm('not the password')
  assert.equal(wrong.statusCode, 401, wrong.body)
  assert.equal((await prisma.executorStandingPolicy.findUniqueOrThrow({ where: { id: body.data.policyId } })).status,
    'preparing')
  const right = await confirm(PASSWORD)
  assert.equal(right.statusCode, 200, right.body)
  const policy = await prisma.executorStandingPolicy.findUniqueOrThrow({ where: { id: body.data.policyId } })
  assert.equal(policy.status, 'live')
  assert.deepEqual(policy.authorOrigin, { organizationId: s.organizationId, teamId: s.teamId, userId: s.authorId })
  assert.equal(await prisma.executorPrivateAssignment.count({
    where: { agentId: s.agentId, executorId: s.minis, principalKind: 'agent' },
  }), 1)
  assert.equal(await prisma.executorAgentOperationGrant.count({
    where: { agentId: s.agentId, executorId: s.minis, state: 'allowed' },
  }), 2)
})

runDatabaseTest('the Machine access section, the machines, the Standing access panel, End and a ticket’s own session', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const s = await seed(prisma, suffix)
  const owner = await prisma.user.create({ data: { displayName: 'Owner', email: `owner-${suffix}@example.test` } })
  await prisma.organizationMember.create({ data: { organizationId: s.organizationId, role: 'owner', userId: owner.id } })
  t.after(async () => {
    await prisma.executorContinuation.deleteMany({ where: { executorId: { in: [s.minis, s.bare] } } })
    await prisma.executorPrivateAssignment.deleteMany({ where: { executorId: { in: [s.minis, s.bare] } } })
    await prisma.executorAgentOperationGrant.deleteMany({ where: { executorId: { in: [s.minis, s.bare] } } })
    await prisma.executorCodingSessionCloseRequest.deleteMany({ where: { executorId: { in: [s.minis, s.bare] } } })
    await prisma.agentTicketWork.deleteMany({ where: { organizationId: s.organizationId } })
    await prisma.executorStandingPolicy.deleteMany({ where: { organizationId: s.organizationId } })
    await prisma.executor.deleteMany({ where: { id: { in: [s.minis, s.bare] } } })
    await prisma.organization.deleteMany({ where: { id: s.organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [s.authorId, s.colleagueId, owner.id] } } })
    await prisma.$disconnect()
  })
  let actorId = s.authorId
  let roles = ['member']
  const deps = {
    buildChannelRealtimeScopes: createRequestHelpers(prisma).buildChannelRealtimeScopes,
    config: { api: { rateLimit: {} } },
    encryptionKeyRing: `standing-views-${suffix}`,
    prisma,
    rateLimiter: { guard: async () => ({ allowed: true }) },
    realtimeHub: { publishWs: async (_scopes: unknown[], input: Record<string, unknown>) => ({ ...input, type: 'event' }) },
    requireActorContext: () => AuthorizedActionContextSchema.parse({
      actionContext: { requestId: randomUUID() },
      actor: { actorId, actorType: 'user', roles },
      tenant: { organizationId: s.organizationId, teamId: s.teamId },
    }),
    requireUserActor: () => true,
  } as unknown as RouteDeps
  const app = Fastify()
  registerTriggerMachineAccessRoutes(app, deps)
  registerStandingPolicyViewRoutes(app, deps)
  registerExecutorRoutes(app, deps)
  t.after(() => app.close())
  const as = (userId: string, asRoles: string[] = ['member']) => {
    actorId = userId
    roles = asRoles
  }
  const get = async <T>(url: string) => {
    const response = await app.inject({ method: 'GET', url })
    return { body: JSON.parse(response.body) as { data: T }, status: response.statusCode }
  }
  type View = {
    policy: { endedByName: string | null; machines: Array<{ label: string }> | null; viewerCanEnd: boolean } | null
    state: string
    tickets: Array<{ machineLabel: string | null; status: string; title: string }>
    viewerIsAuthor: boolean
  }
  const section = `/api/triggers/${s.triggerId}/machine-access`

  // Before anything: not set up, for the author and an owner alike; a member who is neither sees nothing.
  assert.equal((await get<View>(section)).body.data.state, 'not_set_up')
  as(s.colleagueId)
  assert.equal((await get<View>(section)).status, 404)
  as(owner.id, ['owner'])
  const ownerFirst = await get<View>(section)
  assert.deepEqual([ownerFirst.status, ownerFirst.body.data.viewerIsAuthor], [200, false])

  // The setup form's machines: the author's own, each refused only for what no choice can fix.
  assert.equal((await get(`${section}/machines`)).status, 403)
  as(s.authorId)
  const machines = await get<{ machines: Array<{ label: string; refusal: { reason: string } | null }> }>(`${section}/machines`)
  assert.deepEqual(machines.body.data.machines.map((machine) => [machine.label, machine.refusal?.reason ?? null]),
    [['Bare', 'no_reviewed_coding_sessions'], ['Minis', null]])

  // Prepared: awaiting confirmation. Confirmed: live, the machine named to its author only.
  const prepared = JSON.parse((await app.inject({
    method: 'POST', payload: { executorIds: [s.minis] }, url: section,
  })).body) as { data: { accessChangeId: string; confirmationToken: string; policyId: string } }
  assert.equal((await get<View>(section)).body.data.state, 'awaiting_confirmation')
  const confirmed = await app.inject({
    method: 'POST',
    payload: { confirmationToken: prepared.data.confirmationToken, currentPassword: PASSWORD },
    url: `/api/executor-access-changes/${prepared.data.accessChangeId}/confirm`,
  })
  assert.equal(confirmed.statusCode, 200, confirmed.body)
  const trigger = await prisma.agentTrigger.findUniqueOrThrow({
    where: { id: s.triggerId }, select: { scopeProjectId: true, targetChannelId: true },
  })
  const task = await prisma.task.create({
    data: { organizationId: s.organizationId, projectId: trigger.scopeProjectId, status: 'in_progress', title: 'Fix login redirect' },
  })
  const thread = await prisma.thread.create({
    data: { agentId: s.agentId, channelId: trigger.targetChannelId!, title: 'Fix login redirect' },
  })
  const sessionId = randomUUID()
  await prisma.agentTicketWork.create({
    data: {
      agentId: s.agentId, executorId: s.minis, organizationId: s.organizationId, policyId: prepared.data.policyId,
      projectId: trigger.scopeProjectId!, sessionIds: [sessionId], status: 'active', taskId: task.id,
      threadId: thread.id, triggerId: s.triggerId,
    },
  })
  const live = await get<View>(section)
  assert.equal(live.body.data.state, 'live')
  assert.deepEqual(live.body.data.policy?.machines?.map((machine) => machine.label), ['Minis'])
  assert.deepEqual(live.body.data.tickets.map((ticket) => [ticket.title, ticket.status, ticket.machineLabel]),
    [['Fix login redirect', 'active', 'Minis']])
  as(owner.id, ['owner'])
  const ownerLive = await get<View>(section)
  assert.equal(ownerLive.body.data.policy?.machines, null, 'an owner who does not administer the machine is not told it')
  assert.equal(ownerLive.body.data.tickets[0]?.machineLabel, null)
  assert.equal(ownerLive.body.data.policy?.viewerCanEnd, false)

  // The executor page: its Standing access panel, and the ticket's own session named through its work.
  as(s.authorId)
  type Panel = {
    policies: Array<{ activeTickets: number; authorName: string; holdingTicket?: unknown; trigger: { name: string } }>
  }
  const panel = await get<Panel>(
    `/api/executors/${s.minis}/standing-policies`)
  assert.deepEqual(panel.body.data.policies.map((row) => [row.trigger.name, row.authorName, row.activeTickets]),
    [['Pick up tickets', 'Ondrej', 1]])
  // Which ticket holds the machine (T5), named for a reader who can read its project.
  assert.deepEqual(panel.body.data.policies[0]?.holdingTicket, {
    projectId: trigger.scopeProjectId, status: 'active', taskId: task.id, title: 'Fix login redirect',
  })
  as(s.colleagueId)
  assert.equal((await get(`/api/executors/${s.minis}/standing-policies`)).status, 404)
  as(s.authorId)
  const ownerKey = executorCodingSessionOwnerKey(s.minis, {
    actorUserId: s.authorId,
    agentId: s.agentId,
    contextId: ticketWorkCodingSessionContext(prepared.data.policyId, task.id),
  })
  await prisma.executor.update({
    where: { id: s.minis },
    data: {
      localMcp: [{
        available: true, observedAt: new Date().toISOString(), server: 'coding-sessions',
        codingSessions: [{
          agent: 'claude', ownerKey, root: 'nessie', sessionId, status: 'working', title: 'Fix login redirect',
          updatedAt: new Date().toISOString(),
        }],
      }],
    },
  })
  const sessions = await get<{ sessions: Array<{ ownerAgentName: string | null; ticketWork?: unknown }> }>(
    `/api/executors/${s.minis}/coding-sessions`)
  assert.deepEqual(sessions.body.data.sessions.map((session) => [session.ownerAgentName, session.ticketWork]), [[
    'CTO',
    { authorName: 'Ondrej', ticket: { projectId: trigger.scopeProjectId, taskId: task.id, title: 'Fix login redirect' } },
  ]])

  // End: a stranger is told nothing; the author ends it, and the section says who.
  as(s.colleagueId)
  const byColleague = await app.inject({ method: 'POST', url: `/api/standing-policies/${prepared.data.policyId}/end` })
  assert.equal(byColleague.statusCode, 404)
  as(s.authorId)
  const ended = await app.inject({ method: 'POST', url: `/api/standing-policies/${prepared.data.policyId}/end` })
  assert.deepEqual([ended.statusCode, JSON.parse(ended.body).data], [200, { ended: true }])
  const after = await get<View>(section)
  assert.deepEqual([after.body.data.state, after.body.data.policy?.endedByName, after.body.data.tickets.length],
    ['ended', 'Ondrej', 0])
  const close = await prisma.executorCodingSessionCloseRequest.findFirstOrThrow({ where: { sessionId } })
  assert.equal(close.reason, 'policy_ended')
})
