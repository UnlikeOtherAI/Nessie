import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { ensureExecutorLogicalTools, prepareExecutorWorkspacePromotion } from '@nessie/executor-manage'
import { AT_REST_SECRET_PURPOSE, encryptWithKeyRing, toEncryptionKeyRing } from '@nessie/runtime'
import { AuthorizedActionContextSchema, ExecutorCapabilityDescriptorSchema } from '@nessie/schemas'
import Fastify from 'fastify'

import { hashPassword } from '../src/auth/password.js'
import { createRequestHelpers } from '../src/lib/request-helpers.js'
import { registerExecutorRoutes } from '../src/routes/executors.js'
import type { RouteDeps } from '../src/routes/types.js'

/**
 * Confirming a workspace promotion from its review card, through the real
 * confirm route over a real database: the promotion is consumed, its card
 * closes in the same transaction, and every screen showing the card is told
 * — the one settle door whose route has to take the closed cards out of the
 * answer it returns (`agent-card-executor-review.test.ts` covers the others).
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const PASSWORD = 'correct horse battery staple'

type Published = { data: Record<string, unknown>; event: string; scopes: unknown[] }

type World = {
  cardId: string
  channelId: string
  confirmationToken: string
  executorId: string
  messageId: string
  organizationId: string
  promotionId: string
  threadId: string
  userId: string
}

/**
 * A private executor its pairing owner reviewed a draft on: the reviewed
 * descriptor offers `workspace.review` and `workspace.promote`, the agent may
 * use the promotion, the owner's own run produced an acknowledged review, and
 * a promotion prepared from it waits behind a review card in the room.
 */
const seedWorld = async (prisma: PrismaClient, suffix: string, secret: string): Promise<World> => {
  const organization = await prisma.organization.create({ data: { name: `promotion-confirm-${suffix}` } })
  const user = await prisma.user.create({
    data: {
      displayName: 'Owner',
      email: `promotion-confirm-${suffix}@example.test`,
      passwordHash: await hashPassword(PASSWORD),
    },
  })
  await prisma.organizationMember.create({ data: { organizationId: organization.id, role: 'member', userId: user.id } })
  const project = await prisma.project.create({ data: { name: `project-${suffix}`, organizationId: organization.id } })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: `promotion-${suffix}`,
      members: { create: { userId: user.id } },
      organizationId: organization.id,
      projectId: project.id,
      slug: `promotion-confirm-${suffix.slice(0, 8)}`,
      teamId: team.id,
      type: 'standard',
      visibility: 'protected',
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id, title: 'main' } })
  const tools = await ensureExecutorLogicalTools(prisma, organization.id)
  const agent = await prisma.agent.create({
    data: {
      name: `cto-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
      toolPolicy: { [tools.get('workspace.promote')!]: true },
    },
  })
  const executor = await prisma.executor.create({
    data: {
      label: 'Studio Mac',
      lastSeenAt: new Date(),
      organizationId: organization.id,
      pairingOwnerUserId: user.id,
      privateAssignments: {
        create: [
          { principalKind: 'user', role: 'admin', userId: user.id },
          { agentId: agent.id, principalKind: 'agent', role: 'use' },
        ],
      },
      profiles: ['workspace_sandbox'],
      scopeKind: 'private',
      status: 'online',
    },
  })
  const descriptor = ExecutorCapabilityDescriptorSchema.parse({
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 2 },
    localPolicyDigest: `sha256:${'1'.repeat(64)}`,
    operationKeys: ['workspace.review', 'workspace.promote'],
    platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
    profiles: ['workspace_sandbox'],
    protocolVersion: 1,
    revision: 1,
    sandboxBackend: 'none',
    supervisor: 'service',
  })
  const revision = await prisma.executorCapabilityRevision.create({
    data: {
      descriptor,
      executorId: executor.id,
      localPolicyDigest: descriptor.localPolicyDigest,
      reviewedByUserId: user.id,
      reviewStatus: 'active',
      revision: 1,
      signature: 'reviewed-test-descriptor',
    },
  })
  await prisma.executorAgentOperationGrant.create({
    data: {
      agentId: agent.id,
      authorizationRevision: executor.authorizationRevision,
      executorId: executor.id,
      operationKey: 'workspace.promote',
      state: 'allowed',
      updatedByUserId: user.id,
    },
  })

  // The owner's own run reviewed the draft: the command the promotion names,
  // with its encrypted receipt.
  const trigger = await prisma.message.create({
    data: { content: 'Promote the draft', role: 'user', threadId: thread.id, userId: user.id },
  })
  const run = await prisma.run.create({
    data: { agentId: agent.id, status: 'completed', threadId: thread.id, triggerMessageId: trigger.id },
  })
  const binding = await prisma.executorBinding.create({
    data: {
      authorizationRevision: executor.authorizationRevision,
      candidateHandleDigest: 'test',
      capabilityRevisionId: revision.id,
      executorId: executor.id,
      fence: 1n,
      operationKey: 'workspace.review',
      runId: run.id,
    },
  })
  const queueJob = await prisma.queueJob.create({
    data: { payload: {}, status: 'completed', topic: 'executor.command' },
  })
  const toolCall = await prisma.toolCall.create({
    data: {
      agentId: agent.id,
      executorBindingId: binding.id,
      inputSummary: 'Review the draft',
      runId: run.id,
      startedAt: new Date(),
      toolName: 'executor.workspace.review',
    },
  })
  const command = await prisma.executorCommand.create({
    data: {
      argumentDigest: 'test',
      bindingId: binding.id,
      queueJobId: queueJob.id,
      resultCiphertext: JSON.stringify(encryptWithKeyRing(
        toEncryptionKeyRing(secret),
        AT_REST_SECRET_PURPOSE.executorCommand,
        JSON.stringify({
          changeCount: 1,
          changes: [{ byteCount: 12, kind: 'created', path: 'draft.txt' }],
          manifestDigest: `sha256:${'a'.repeat(64)}`,
          success: true,
        }),
      )),
      resultDigest: `sha256:${'b'.repeat(64)}`,
      state: 'result_acknowledged',
      toolCallId: toolCall.id,
    },
  })

  const actor = AuthorizedActionContextSchema.parse({
    actionContext: { requestId: randomUUID() },
    actor: { actorId: user.id, actorType: 'user', roles: ['member'] },
    tenant: { organizationId: organization.id },
  })
  const prepared = await prepareExecutorWorkspacePromotion(prisma, secret, actor, { reviewCommandId: command.id })
  const message = await prisma.message.create({
    data: { agentId: agent.id, content: 'Confirm a workspace promotion', role: 'assistant', threadId: thread.id },
  })
  const card = await prisma.agentCard.create({
    data: {
      agentId: agent.id,
      channelId: channel.id,
      executorWorkspacePromotionId: prepared.promotionId,
      expiresAt: prepared.expiresAt,
      messageId: message.id,
      organizationId: organization.id,
      respondentUserIds: [user.id],
      runId: run.id,
      spec: {
        actions: [{ key: 'review', label: 'Review', style: 'primary', submits: true }],
        blocks: [{ markdown: 'Review opens exactly what changes.', type: 'text' }],
        schemaVersion: 1,
        subtitle: 'Write 1 reviewed change to the host workspace',
        title: 'Confirm a workspace promotion',
      },
      threadId: thread.id,
    },
  })
  return {
    cardId: card.id,
    channelId: channel.id,
    confirmationToken: prepared.confirmationToken,
    executorId: executor.id,
    messageId: message.id,
    organizationId: organization.id,
    promotionId: prepared.promotionId,
    threadId: thread.id,
    userId: user.id,
  }
}

runDatabaseTest('confirming a workspace promotion tells every open screen its card closed', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const secret = `promotion-confirm-${randomUUID()}`
  const organizationName = `promotion-confirm-${suffix}`
  t.after(async () => {
    // Commands restrict their queue jobs' deletion, and bindings their executor's.
    const queueJobs = await prisma.executorCommand.findMany({
      where: { binding: { executor: { organization: { name: organizationName } } } },
      select: { queueJobId: true },
    })
    await prisma.executorCommand.deleteMany({ where: { binding: { executor: { organization: { name: organizationName } } } } })
    await prisma.executorBinding.deleteMany({ where: { executor: { organization: { name: organizationName } } } })
    await prisma.queueJob.deleteMany({ where: { id: { in: queueJobs.map((job) => job.queueJobId) } } })
    await prisma.executor.deleteMany({ where: { organization: { name: organizationName } } })
    await prisma.organization.deleteMany({ where: { name: organizationName } })
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
    await prisma.$disconnect()
  })
  const world = await seedWorld(prisma, suffix, secret)

  const published: Published[] = []
  const app = Fastify()
  registerExecutorRoutes(app, {
    buildChannelRealtimeScopes: createRequestHelpers(prisma).buildChannelRealtimeScopes,
    config: { api: { rateLimit: {} } },
    encryptionKeyRing: secret,
    prisma,
    rateLimiter: { guard: async () => ({ allowed: true }) },
    realtimeHub: {
      publishWs: async (scopes: unknown[], input: { data: Record<string, unknown>; event: string }) => {
        published.push({ data: input.data, event: input.event, scopes })
        return { ...input, ts: new Date().toISOString(), type: 'event' }
      },
    },
    requireActorContext: () => AuthorizedActionContextSchema.parse({
      actionContext: { requestId: randomUUID() },
      actor: { actorId: world.userId, actorType: 'user', roles: ['member'] },
      tenant: { organizationId: world.organizationId },
    }),
    requireUserActor: () => true,
  } as unknown as RouteDeps)
  t.after(() => app.close())

  const response = await app.inject({
    method: 'POST',
    payload: { confirmationToken: world.confirmationToken, currentPassword: PASSWORD },
    url: `/api/executor-workspace-promotions/${world.promotionId}/confirm`,
  })
  assert.equal(response.statusCode, 200, response.body)
  const body = JSON.parse(response.body) as { data: Record<string, unknown> }
  assert.equal(body.data.promotionId, world.promotionId)
  assert.equal(body.data.executorId, world.executorId)
  assert.ok(typeof body.data.commandId === 'string', 'the promotion was queued as a command')
  assert.equal('closedReviewCards' in body.data, false, 'the closed cards are the route’s to announce, not to return')

  const promotion = await prisma.executorContinuation.findUniqueOrThrow({ where: { id: world.promotionId } })
  assert.equal(promotion.status, 'consumed')
  const card = await prisma.agentCard.findUniqueOrThrow({ where: { id: world.cardId } })
  assert.equal(card.status, 'resolved')
  assert.equal(card.resolvedByUserId, world.userId)
  assert.deepEqual(
    published.filter((entry) => entry.event === 'card.updated').map((entry) => [entry.data, entry.scopes]),
    [[
      { cardId: world.cardId, messageId: world.messageId, status: 'resolved', threadId: world.threadId },
      [{ kind: 'channel', channelId: world.channelId }],
    ]],
    'every open screen is told the card closed, once',
  )
})
