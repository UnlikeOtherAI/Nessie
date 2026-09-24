import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient, type Prisma } from '@prisma/client'
import { AuthorizedActionContextSchema, ExecutorCapabilityDescriptorSchema } from '@nessie/schemas'
import { createAgentTrigger } from '@nessie/team-admin'
import Fastify from 'fastify'

import { hashPassword } from '../src/auth/password.js'
import { createRequestHelpers } from '../src/lib/request-helpers.js'
import { registerExecutorRoutes } from '../src/routes/executors.js'
import { registerTriggerMachineAccessRoutes } from '../src/routes/trigger-machine-access.js'
import type { RouteDeps } from '../src/routes/types.js'

/**
 * A ticket trigger's machine access through its routes, over a real database
 * (docs/standards/ticket-work.md): prepared from the trigger's Machine access
 * section by its author alone, each machine that cannot take the work named
 * with its reason, and confirmed through the executor access-change door with
 * the author's password — which applies the assignment, the grant and the
 * policy in one step.
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const PASSWORD = 'correct horse battery staple'

const seed = async (prisma: PrismaClient, suffix: string) => {
  const organization = await prisma.organization.create({ data: { name: `standing-routes-${suffix}` } })
  const organizationId = organization.id
  const [author, colleague] = await Promise.all(['Ondrej', 'Colleague'].map(async (displayName) => prisma.user.create({
    data: {
      displayName, email: `${displayName.toLowerCase()}-${suffix}@example.test`, passwordHash: await hashPassword(PASSWORD),
    },
  })))
  await prisma.organizationMember.createMany({
    data: [author!, colleague!].map((user) => ({ organizationId, role: 'member' as const, userId: user.id })),
  })
  const project = await prisma.project.create({ data: { name: 'Nessie', organizationId } })
  await prisma.projectMember.createMany({
    data: [author!, colleague!].map((user) => ({ projectId: project.id, role: 'member' as const, userId: user.id })),
  })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const board = await prisma.board.create({
    data: { isDefault: true, name: 'Engineering', organizationId, position: 0, projectId: project.id },
  })
  for (const [name, category, position] of [['Backlog', 'todo', 0], ['In progress', 'in_progress', 1], ['Done', 'done', 2]] as const) {
    await prisma.boardColumn.create({ data: { boardId: board.id, category, name, organizationId, position } })
  }
  const channel = await prisma.channel.create({
    data: {
      label: 'eng', organizationId, projectId: project.id, slug: `eng-${suffix}`, teamId: team.id, visibility: 'public',
    },
  })
  const agent = await prisma.agent.create({ data: { name: 'CTO', organizationId, projectId: project.id } })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  const trigger = await createAgentTrigger(prisma, agent.id, {
    config: { instructions: { general: 'Have Claude fix it.' }, pickup: { columns: [{ name: 'In progress' }] } },
    name: 'Pick up tickets',
    targetChannelId: channel.id,
    type: 'ticket_changed',
  }, { authorUserId: author!.id })
  assert.ok(trigger)
  const machine = async (label: string, codingSessions: Record<string, unknown> | null) => {
    const descriptor = ExecutorCapabilityDescriptorSchema.parse({
      ...(codingSessions ? { codingSessions, mcpServers: ['coding-sessions'] } : {}),
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 2 },
      localPolicyDigest: `sha256:${'1'.repeat(64)}`,
      operationKeys: ['mcp.tools', 'mcp.call'],
      platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
      profiles: ['workspace_sandbox'],
      protocolVersion: 1,
      revision: 1,
      sandboxBackend: 'none',
      supervisor: 'service',
    })
    return (await prisma.executor.create({
      data: {
        capabilityRevisions: {
          create: {
            descriptor: descriptor as unknown as Prisma.InputJsonValue, localPolicyDigest: descriptor.localPolicyDigest,
            reviewStatus: 'active', revision: 1, signature: 'reviewed',
          },
        },
        label, lastSeenAt: new Date(), organizationId, pairingOwnerUserId: author!.id,
        privateAssignments: { create: { principalKind: 'user', role: 'admin', userId: author!.id } },
        profiles: ['workspace_sandbox'], scopeKind: 'private', status: 'online',
      },
    })).id
  }
  const minis = await machine('Minis', {
    agents: ['claude'], allowedToolCount: 2, configDigest: `sha256:${'c'.repeat(64)}`, environmentNames: [],
    maxBudgetUsd: { claude: 5 }, maxLiveSessionsPerOwner: 3,
    mergeCommands: ['git push', 'gh pr create', 'gh pr checks', 'gh pr merge'],
    permissionMode: { claude: 'acceptEdits' }, rootNames: ['nessie'], serverName: 'coding-sessions',
  })
  const bare = await machine('Bare', null)
  return {
    agentId: agent.id, authorId: author!.id, bare, colleagueId: colleague!.id, minis, organizationId,
    teamId: team.id, triggerId: trigger.id,
  }
}

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
