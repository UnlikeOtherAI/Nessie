import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema } from '@nessie/schemas'
import Fastify from 'fastify'

import { sendApiError } from '../src/lib/api.js'
import { createGrant, deleteGrant } from '../src/services/tool-grants.js'
import { createRequestHelpers } from '../src/lib/request-helpers.js'
import { registerExecutorRoutes } from '../src/routes/executors.js'
import { registerTriggerMachineAccessRoutes } from '../src/routes/trigger-machine-access.js'
import { registerTriggerRoutes } from '../src/routes/triggers.js'
import type { RouteDeps } from '../src/routes/types.js'
import { PASSWORD, seedStandingPolicyRoutes as seed } from './standing-policy-routes-fixture.js'

/**
 * A ticket trigger with live machine access, through the Triggers routes over
 * a real database (docs/standards/ticket-work-machine-access.md):
 *
 * - `PUT /api/triggers/:triggerId` answers what the save did to that access
 *   beside the trigger — nothing for a rename, `limits_lowered` for a lower
 *   limit, `suspended` with the author's name and the fields for an edited
 *   instruction — so the editor never pauses it silently;
 * - `GET /api/triggers/:triggerId` and its `/history` answer an owner and the
 *   trigger's author, who need not be an owner, and nobody else;
 * - a connector granted to the agent, or taken from it, suspends the access
 *   it pins (`agent_changed`) in the grant's own transaction.
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

runDatabaseTest('a trigger edit answers what it did to machine access, and its author reads the trigger', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const s = await seed(prisma, suffix)
  const owner = await prisma.user.create({ data: { displayName: 'Owner', email: `owner-${suffix}@example.test` } })
  await prisma.organizationMember.create({ data: { organizationId: s.organizationId, role: 'owner', userId: owner.id } })
  t.after(async () => {
    await prisma.executorContinuation.deleteMany({ where: { executorId: { in: [s.minis, s.bare] } } })
    await prisma.executorPrivateAssignment.deleteMany({ where: { executorId: { in: [s.minis, s.bare] } } })
    await prisma.executorAgentOperationGrant.deleteMany({ where: { executorId: { in: [s.minis, s.bare] } } })
    await prisma.executorStandingPolicy.deleteMany({ where: { organizationId: s.organizationId } })
    await prisma.executor.deleteMany({ where: { id: { in: [s.minis, s.bare] } } })
    await prisma.organization.deleteMany({ where: { id: s.organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [s.authorId, s.colleagueId, owner.id] } } })
    await prisma.$disconnect()
  })

  let actorId = s.authorId
  let roles = ['member']
  const as = (userId: string, asRoles: string[] = ['member']) => {
    actorId = userId
    roles = asRoles
  }
  const helpers = createRequestHelpers(prisma)
  const deps = {
    buildChannelRealtimeScopes: helpers.buildChannelRealtimeScopes,
    config: { api: { rateLimit: {} } },
    encryptionKeyRing: `trigger-edit-${suffix}`,
    isAgentAccessibleToActor: helpers.isAgentAccessibleToActor,
    isTriggerAccessibleToActor: helpers.isTriggerAccessibleToActor,
    prisma,
    rateLimiter: { guard: async () => ({ allowed: true }) },
    realtimeHub: { publishWs: async (_scopes: unknown[], input: Record<string, unknown>) => ({ ...input, type: 'event' }) },
    requireActorContext: () => AuthorizedActionContextSchema.parse({
      actionContext: { requestId: randomUUID() },
      actor: { actorId, actorType: 'user', roles },
      tenant: { organizationId: s.organizationId, teamId: s.teamId },
    }),
    // What the server's own gate does: owners pass, everyone else is refused.
    requireOwner: (context: { actor: { roles?: string[] } }, reply: Parameters<typeof sendApiError>[0]) => {
      if (context.actor.roles?.includes('owner')) return true
      sendApiError(reply, 403, 'FORBIDDEN', 'Owner access required')
      return false
    },
    requireUserActor: () => true,
  } as unknown as RouteDeps
  const app = Fastify()
  registerTriggerRoutes(app, deps)
  registerTriggerMachineAccessRoutes(app, deps)
  registerExecutorRoutes(app, deps)
  t.after(() => app.close())
  const trigger = `/api/triggers/${s.triggerId}`

  // Live: the author prepares machine access and confirms it with their password.
  const prepared = JSON.parse((await app.inject({
    method: 'POST', payload: { executorIds: [s.minis] }, url: `${trigger}/machine-access`,
  })).body) as { data: { accessChangeId: string; confirmationToken: string; policyId: string } }
  const confirmed = await app.inject({
    method: 'POST',
    payload: { confirmationToken: prepared.data.confirmationToken, currentPassword: PASSWORD },
    url: `/api/executor-access-changes/${prepared.data.accessChangeId}/confirm`,
  })
  assert.equal(confirmed.statusCode, 200, confirmed.body)
  const policyStatus = async () =>
    (await prisma.executorStandingPolicy.findUniqueOrThrow({ where: { id: prepared.data.policyId } })).status

  // F12: the author, a member and not an owner, reads the trigger's page; a colleague does not.
  type Record = { data: { config: { [key: string]: unknown }; id: string; type: string } }
  const read = async (url: string) => {
    const response = await app.inject({ method: 'GET', url })
    return { body: JSON.parse(response.body) as unknown, status: response.statusCode }
  }
  const byAuthor = await read(trigger)
  assert.equal(byAuthor.status, 200, JSON.stringify(byAuthor.body))
  const record = (byAuthor.body as Record).data
  assert.deepEqual([record.id, record.type], [s.triggerId, 'ticket_changed'])
  assert.equal(record.config.authorUserId, undefined, 'who set it up stays on the server')
  const history = await read(`${trigger}/history?limit=5`)
  assert.equal(history.status, 200, JSON.stringify(history.body))
  assert.ok(Array.isArray((history.body as { data: unknown }).data))
  // An author who can no longer edit the board has lost the page with it.
  await prisma.projectMember.deleteMany({ where: { projectId: s.projectId, userId: s.authorId } })
  assert.equal((await read(trigger)).status, 404, 'an author off the project is not told it exists')
  assert.equal((await read(`${trigger}/history`)).status, 404)
  await prisma.projectMember.create({ data: { projectId: s.projectId, role: 'member', userId: s.authorId } })
  assert.equal((await read(trigger)).status, 200)
  as(s.colleagueId)
  assert.equal((await read(trigger)).status, 404, 'a member who did not set it up is not told it exists')
  assert.equal((await read(`${trigger}/history`)).status, 404)
  assert.equal((await read('/api/triggers/not-a-trigger')).status, 404)
  as(owner.id, ['owner'])
  assert.equal((await read(trigger)).status, 200, 'an owner reads it as every Triggers read')
  assert.equal((await read(`${trigger}/history`)).status, 200)

  // F5: the owner's edits, and what each did to the author's live machine access.
  type Saved = { data: { id: string; machineAccess?: unknown; name?: string } }
  const save = async (payload: object) => {
    const response = await app.inject({ method: 'PUT', payload, url: trigger })
    assert.equal(response.statusCode, 200, response.body)
    return (JSON.parse(response.body) as Saved).data
  }
  const renamed = await save({ name: 'Pick up tickets now' })
  assert.deepEqual([renamed.name, renamed.machineAccess], ['Pick up tickets now', undefined], 'a rename pins nothing')
  assert.equal(await policyStatus(), 'live')

  const lowered = await save({ config: { limits: { wakesPerTicket: 5 } } })
  assert.deepEqual(lowered.machineAccess, { kind: 'limits_lowered' })
  assert.equal(await policyStatus(), 'live', 'a lower limit keeps it live')

  const edited = await save({ config: { instructions: { general: 'Have Claude fix it and open a pull request.' } } })
  assert.equal(edited.id, s.triggerId)
  assert.deepEqual(edited.machineAccess, { authorName: 'Ondrej', fields: ['the general instructions'], kind: 'suspended' })
  assert.equal(await policyStatus(), 'suspended')

  // S2: the agent's connectors are pinned too. Confirm again, then grant one and take it back.
  as(s.authorId)
  const confirmAgain = async (): Promise<string> => {
    const again = JSON.parse((await app.inject({
      method: 'POST', payload: { executorIds: [s.minis] }, url: `${trigger}/machine-access`,
    })).body) as { data: { accessChangeId: string; confirmationToken: string; policyId: string } }
    const done = await app.inject({
      method: 'POST',
      payload: { confirmationToken: again.data.confirmationToken, currentPassword: PASSWORD },
      url: `/api/executor-access-changes/${again.data.accessChangeId}/confirm`,
    })
    assert.equal(done.statusCode, 200, done.body)
    return again.data.policyId
  }
  const statusOf = async (policyId: string) => prisma.executorStandingPolicy.findUniqueOrThrow({
    where: { id: policyId }, select: { status: true, suspendedReason: true },
  })
  const connector = await prisma.toolRegistryEntry.create({
    data: {
      description: 'Create an issue in the tracker.', enabled: true, handlerKind: 'mcp', label: 'Create issue',
      organizationId: s.organizationId, overview: 'Issue creation.', scopeKey: `scope-${suffix}`,
      source: 'mcp_remote', status: 'active', toolId: `issue_create_${suffix}`, transport: 'mcp',
    },
  })
  const granted = await confirmAgain()
  const grant = await createGrant(prisma, {
    actorUserId: owner.id, agentId: s.agentId, organizationId: s.organizationId, toolRegistryEntryId: connector.id,
  })
  assert.deepEqual(await statusOf(granted), { status: 'suspended', suspendedReason: 'agent_changed' })
  const revoked = await confirmAgain()
  assert.equal(await deleteGrant(prisma, s.organizationId, connector.id, grant.id, owner.id), true)
  assert.deepEqual(await statusOf(revoked), { status: 'suspended', suspendedReason: 'agent_changed' })
})
