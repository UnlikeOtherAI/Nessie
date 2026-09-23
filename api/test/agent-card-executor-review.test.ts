import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'
import {
  confirmExecutorAccessChange,
  prepareExecutorAccessChange,
  type ExecutorAccessChange,
} from '@nessie/executor-manage'
import { AuthorizedActionContextSchema, type AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { createRequestHelpers } from '../src/lib/request-helpers.js'
import { registerAgentCardRoutes } from '../src/routes/agent-cards.js'
import type { RouteDeps } from '../src/routes/types.js'

/**
 * F6: the Designer's executor grant could not be confirmed from chat.
 *
 * The prepare tool put `#confirmationToken=<token>` in its output; the secret
 * scanner rightly redacted it before the model saw it, so the link it posted
 * opened a review with no token. The tool now posts a review card holding only
 * the change's id, and pressing it mints the token for the presser inside the
 * press. These drive the real press route over a real database and then the
 * unchanged confirm rules with whatever the press handed back.
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const REVIEW_CARD = {
  schemaVersion: 1,
  title: 'Confirm an executor change',
  subtitle: 'Pause this executor',
  blocks: [{ type: 'text', markdown: 'Review opens exactly what changes.' }],
  actions: [{ key: 'review', label: 'Review', style: 'primary', submits: true }],
}

type Seed = {
  actor: AuthorizedActionContext
  agentId: string
  channelId: string
  executorId: string
  organizationId: string
  otherUserId: string
  runId: string
  threadId: string
  userId: string
}

const actorFor = (userId: string, organizationId: string): AuthorizedActionContext =>
  AuthorizedActionContextSchema.parse({
    actionContext: { requestId: randomUUID() },
    actor: { actorId: userId, actorType: 'user', roles: ['member'] },
    tenant: { organizationId },
  })

const seed = async (prisma: PrismaClient, suffix: string): Promise<Seed> => {
  const organization = await prisma.organization.create({ data: { name: `executor-review-${suffix}` } })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: `review-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      slug: `executor-review-${suffix.slice(0, 8)}`,
      teamId: team.id,
      type: 'standard',
      visibility: 'protected',
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id, title: 'main' } })
  const agent = await prisma.agent.create({
    data: { name: `designer-${suffix}`, organizationId: organization.id, projectId: project.id, teamId: team.id },
  })
  const [user, other] = await Promise.all(['owner', 'bystander'].map((name) => prisma.user.create({
    data: { displayName: name, email: `executor-review-${name}-${suffix}@example.test` },
  })))
  await prisma.organizationMember.createMany({
    data: [user!, other!].map((person) => ({ organizationId: organization.id, role: 'member' as const, userId: person.id })),
  })
  await prisma.channelMember.createMany({
    data: [user!, other!].map((person) => ({ channelId: channel.id, userId: person.id })),
  })
  const run = await prisma.run.create({ data: { agentId: agent.id, status: 'completed', threadId: thread.id } })
  const executor = await prisma.executor.create({
    data: {
      label: 'Studio Mac',
      lastSeenAt: new Date(),
      organizationId: organization.id,
      pairingOwnerUserId: user!.id,
      privateAssignments: { create: { principalKind: 'user', role: 'admin', userId: user!.id } },
      profiles: ['workspace_sandbox'],
      scopeKind: 'private',
      status: 'online',
    },
  })
  return {
    actor: actorFor(user!.id, organization.id),
    agentId: agent.id,
    channelId: channel.id,
    executorId: executor.id,
    organizationId: organization.id,
    otherUserId: other!.id,
    runId: run.id,
    threadId: thread.id,
    userId: user!.id,
  }
}

/** What the prepare tool writes: a card that knows only the change's id. */
const prepareWithCard = async (
  prisma: PrismaClient,
  s: Seed,
  change: ExecutorAccessChange,
  respondentUserIds: string[] = [s.userId],
) => {
  const prepared = await prepareExecutorAccessChange(prisma, s.actor, { change, executorId: s.executorId })
  const message = await prisma.message.create({
    data: { agentId: s.agentId, content: 'Confirm an executor change', role: 'assistant', threadId: s.threadId },
  })
  const card = await prisma.agentCard.create({
    data: {
      agentId: s.agentId,
      channelId: s.channelId,
      executorAccessChangeId: prepared.accessChangeId,
      expiresAt: prepared.expiresAt,
      messageId: message.id,
      organizationId: s.organizationId,
      respondentUserIds,
      runId: s.runId,
      spec: REVIEW_CARD,
      threadId: s.threadId,
    },
  })
  return { cardId: card.id, prepared }
}

const press = async (prisma: PrismaClient, s: Seed, cardId: string, userId = s.userId) => {
  const actorContext = actorFor(userId, s.organizationId)
  const app = Fastify()
  registerAgentCardRoutes(app, {
    buildChannelRealtimeScopes: createRequestHelpers(prisma).buildChannelRealtimeScopes,
    dashboardCredentials: {},
    mcpSecretStore: {},
    messageMemoryCaptureConfig: null,
    prisma,
    realtimeHub: { publishWs: async () => undefined },
    requireActorContext: () => actorContext,
  } as unknown as RouteDeps & { dashboardCredentials: unknown })
  const response = await app.inject({
    method: 'POST',
    payload: { actionKey: 'review' },
    url: `/api/agent-cards/${cardId}/respond`,
  })
  await app.close()
  return response
}

const withSeed = async (
  t: test.TestContext,
  run: (prisma: PrismaClient, s: Seed) => Promise<void>,
): Promise<void> => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(async () => {
    await prisma.executor.deleteMany({ where: { organization: { name: `executor-review-${suffix}` } } })
    await prisma.organization.deleteMany({ where: { name: `executor-review-${suffix}` } })
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
    await prisma.$disconnect()
  })
  await run(prisma, await seed(prisma, suffix))
}

const confirm = (
  prisma: PrismaClient,
  s: Seed,
  input: { accessChangeId: string; confirmationToken: string; freshVerificationSatisfied: boolean },
) => confirmExecutorAccessChange(prisma, s.actor, input)

runDatabaseTest('pressing Review hands the presser the one token that confirms the change', async (t) => {
  await withSeed(t, async (prisma, s) => {
    const { cardId, prepared } = await prepareWithCard(prisma, s, { action: 'pause', kind: 'lifecycle' })

    const response = await press(prisma, s, cardId)
    assert.equal(response.statusCode, 200, response.body)
    const body = JSON.parse(response.body) as {
      data: { executorReview?: { accessChangeId: string; confirmationToken: string }; status: string }
    }
    assert.equal(body.data.status, 'resolved')
    const review = body.data.executorReview
    assert.ok(review, 'the press answers with the review it opens')
    assert.equal(review.accessChangeId, prepared.accessChangeId)
    assert.notEqual(review.confirmationToken, prepared.confirmationToken)

    // The token is in that response and nowhere durable.
    const card = await prisma.agentCard.findUniqueOrThrow({ where: { id: cardId } })
    assert.equal(card.status, 'resolved')
    assert.equal(JSON.stringify(card).includes(review.confirmationToken), false)
    const reply = await prisma.message.findUniqueOrThrow({ where: { id: card.responseMessageId! } })
    assert.equal(JSON.stringify(reply).includes(review.confirmationToken), false)
    // A review is the person's to finish, so the press does not wake the agent.
    const woken = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS count FROM queue_jobs WHERE idempotency_key = ${`orchestrate:card:${cardId}`}
    `)
    assert.equal(Number(woken[0]?.count), 0)

    // The token minted at prepare time was shown to nobody and is now dead.
    await assert.rejects(
      confirm(prisma, s, { ...prepared, freshVerificationSatisfied: false }),
      /Access change not found/,
    )
    // The press's token confirms, under the unchanged rules.
    const confirmed = await confirm(prisma, s, { ...review, freshVerificationSatisfied: false })
    assert.equal(confirmed.executorId, s.executorId)
    const executor = await prisma.executor.findUniqueOrThrow({ where: { id: s.executorId } })
    assert.equal(executor.status, 'paused')
  })
})

runDatabaseTest('a change that needs fresh verification still needs it', async (t) => {
  await withSeed(t, async (prisma, s) => {
    const { cardId } = await prepareWithCard(prisma, s, { action: 'revoke', kind: 'lifecycle' })
    const response = await press(prisma, s, cardId)
    assert.equal(response.statusCode, 200, response.body)
    const review = (JSON.parse(response.body) as {
      data: { executorReview: { accessChangeId: string; confirmationToken: string } }
    }).data.executorReview

    await assert.rejects(
      confirm(prisma, s, { ...review, freshVerificationSatisfied: false }),
      /Fresh verification is required/,
    )
    const executor = await prisma.executor.findUniqueOrThrow({ where: { id: s.executorId } })
    assert.equal(executor.status, 'online', 'nothing was applied without the proof')
  })
})

runDatabaseTest('only the person who prepared the change can be handed its token', async (t) => {
  await withSeed(t, async (prisma, s) => {
    // Thread-wide on purpose: the card system would let anyone press it, so
    // this proves the review itself binds to the preparer.
    const { cardId, prepared } = await prepareWithCard(prisma, s, { action: 'pause', kind: 'lifecycle' }, [])
    const before = await prisma.executorContinuation.findUniqueOrThrow({ where: { id: prepared.accessChangeId } })

    const response = await press(prisma, s, cardId, s.otherUserId)
    assert.equal(response.statusCode, 409, response.body)
    assert.match(response.body, /EXECUTOR_ACCESS_CHANGE_STALE/)
    assert.equal(response.body.includes('confirmationToken'), false)

    const card = await prisma.agentCard.findUniqueOrThrow({ where: { id: cardId } })
    assert.equal(card.status, 'open', 'a refused press leaves the card for its person')
    const after = await prisma.executorContinuation.findUniqueOrThrow({ where: { id: prepared.accessChangeId } })
    assert.equal(after.confirmationTokenHash, before.confirmationTokenHash)
  })
})

runDatabaseTest('a change that is no longer pending refuses the press and leaves the card open', async (t) => {
  await withSeed(t, async (prisma, s) => {
    const { cardId, prepared } = await prepareWithCard(prisma, s, { action: 'pause', kind: 'lifecycle' })
    // Confirmed through another door — the Executors page with its own token.
    await confirm(prisma, s, { ...prepared, freshVerificationSatisfied: false })

    const response = await press(prisma, s, cardId)
    assert.equal(response.statusCode, 409, response.body)
    assert.match(response.body, /no longer waiting for your review/)
    const card = await prisma.agentCard.findUniqueOrThrow({ where: { id: cardId } })
    assert.equal(card.status, 'open')
    assert.equal(card.responseMessageId, null)
  })
})
