import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'
import {
  confirmExecutorAccessChange,
  prepareExecutorAccessChange,
  rejectExecutorAccessChange,
  rejectExecutorWorkspacePromotion,
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
 * the change's id, and every press mints a fresh token for the presser while
 * the change is pending; the card closes when the change does. These drive the
 * real press route over a real database and then the unchanged confirm rules
 * with whatever the press handed back.
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


type PressBody = {
  data: {
    executorReview?: { accessChangeId?: string; confirmationToken: string; promotionId?: string }
    responseMessageId?: string
    status: string
  }
}

const reviewFrom = async (prisma: PrismaClient, s: Seed, cardId: string) => {
  const response = await press(prisma, s, cardId)
  assert.equal(response.statusCode, 200, response.body)
  const body = JSON.parse(response.body) as PressBody
  // Pressed, never answered: the card is still open for the next press.
  assert.equal(body.data.status, 'open')
  assert.equal(body.data.responseMessageId, undefined)
  const review = body.data.executorReview
  assert.ok(review, 'the press answers with the review it opens')
  return review
}

runDatabaseTest('every press hands the presser a fresh token, and only the newest confirms', async (t) => {
  await withSeed(t, async (prisma, s) => {
    const { cardId, prepared } = await prepareWithCard(prisma, s, { action: 'pause', kind: 'lifecycle' })

    const first = await reviewFrom(prisma, s, cardId)
    assert.equal(first.accessChangeId, prepared.accessChangeId)
    assert.notEqual(first.confirmationToken, prepared.confirmationToken)
    // The review closed without confirming — or the response was lost, the
    // page reloaded, another device opened the DM. The card is still open, so
    // the same person just presses again.
    let card = await prisma.agentCard.findUniqueOrThrow({ where: { id: cardId } })
    assert.equal(card.status, 'open')
    const second = await reviewFrom(prisma, s, cardId)
    assert.notEqual(second.confirmationToken, first.confirmationToken)

    // The tokens are in those responses and nowhere durable, and a press
    // writes no reply and wakes nobody: the review is the person's to finish.
    card = await prisma.agentCard.findUniqueOrThrow({ where: { id: cardId } })
    for (const token of [first.confirmationToken, second.confirmationToken]) {
      assert.equal(JSON.stringify(card).includes(token), false)
    }
    assert.equal(card.responseMessageId, null)
    assert.equal(await prisma.message.count({
      where: { metadata: { path: ['agentCardResponse', 'cardId'], equals: cardId } },
    }), 0)
    const woken = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS count FROM queue_jobs WHERE idempotency_key = ${`orchestrate:card:${cardId}`}
    `)
    assert.equal(Number(woken[0]?.count), 0)
    assert.equal(await prisma.auditLog.count({
      where: { action: 'agent_card.responded', organizationId: s.organizationId, resourceId: cardId },
    }), 2, 'each press is on the audit trail')

    // Only the newest token works: the prepare-time one (shown to nobody) and
    // the first press's are dead.
    for (const stale of [prepared.confirmationToken, first.confirmationToken]) {
      await assert.rejects(
        confirm(prisma, s, {
          accessChangeId: prepared.accessChangeId,
          confirmationToken: stale,
          freshVerificationSatisfied: false,
        }),
        /Access change not found/,
      )
    }
    const confirmed = await confirm(prisma, s, {
      accessChangeId: prepared.accessChangeId,
      confirmationToken: second.confirmationToken,
      freshVerificationSatisfied: false,
    })
    assert.equal(confirmed.executorId, s.executorId)
    const executor = await prisma.executor.findUniqueOrThrow({ where: { id: s.executorId } })
    assert.equal(executor.status, 'paused')

    // Confirming closed the card in the same transaction, as its preparer.
    card = await prisma.agentCard.findUniqueOrThrow({ where: { id: cardId } })
    assert.equal(card.status, 'resolved')
    assert.equal(card.resolvedActionKey, 'review')
    assert.equal(card.resolvedByUserId, s.userId)
    const after = await press(prisma, s, cardId)
    assert.equal(after.statusCode, 409, after.body)
    assert.match(after.body, /CARD_NOT_OPEN/)
  })
})

runDatabaseTest('a change that needs fresh verification still needs it', async (t) => {
  await withSeed(t, async (prisma, s) => {
    const { cardId } = await prepareWithCard(prisma, s, {
      action: 'set', assignment: { principalKind: 'user', role: 'use', userId: s.otherUserId }, kind: 'private_assignment',
    })
    const review = await reviewFrom(prisma, s, cardId)

    await assert.rejects(
      confirm(prisma, s, {
        accessChangeId: review.accessChangeId!,
        confirmationToken: review.confirmationToken,
        freshVerificationSatisfied: false,
      }),
      /Fresh verification is required/,
    )
    const granted = await prisma.executorPrivateAssignment.count({
      where: { executorId: s.executorId, userId: s.otherUserId },
    })
    assert.equal(granted, 0, 'nothing was applied without the proof')
    const card = await prisma.agentCard.findUniqueOrThrow({ where: { id: cardId } })
    assert.equal(card.status, 'open', 'a refused confirm leaves the card to press again')
  })
})

runDatabaseTest('rejecting the change from its review cancels the card', async (t) => {
  await withSeed(t, async (prisma, s) => {
    const { cardId, prepared } = await prepareWithCard(prisma, s, { action: 'pause', kind: 'lifecycle' })
    const review = await reviewFrom(prisma, s, cardId)

    await rejectExecutorAccessChange(prisma, s.actor, {
      accessChangeId: prepared.accessChangeId,
      confirmationToken: review.confirmationToken,
    })
    const card = await prisma.agentCard.findUniqueOrThrow({ where: { id: cardId } })
    assert.equal(card.status, 'cancelled')
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

    // A bystander's press neither closes the card nor rotates the token.
    const card = await prisma.agentCard.findUniqueOrThrow({ where: { id: cardId } })
    assert.equal(card.status, 'open', 'a refused press leaves the card for its person')
    const after = await prisma.executorContinuation.findUniqueOrThrow({ where: { id: prepared.accessChangeId } })
    assert.equal(after.confirmationTokenHash, before.confirmationTokenHash)
  })
})

// A press that finds the change already over closes the card to match rather
// than leaving a live Review button that always fails until the sweep runs.
runDatabaseTest('a change that is over closes its card on the next press', async (t) => {
  await withSeed(t, async (prisma, s) => {
    const cases = [
      { data: { status: 'consumed' as const }, expected: 'resolved' },
      { data: { status: 'rejected' as const }, expected: 'cancelled' },
      { data: { expiresAt: new Date(Date.now() - 1_000) }, expected: 'expired' },
    ]
    for (const { data, expected } of cases) {
      const { cardId, prepared } = await prepareWithCard(prisma, s, { action: 'pause', kind: 'lifecycle' })
      // Settled through a door that is not the card, behind the card's back.
      await prisma.executorContinuation.update({ where: { id: prepared.accessChangeId }, data })

      const response = await press(prisma, s, cardId)
      assert.equal(response.statusCode, 409, response.body)
      assert.match(response.body, /no longer waiting for your review/)
      const card = await prisma.agentCard.findUniqueOrThrow({ where: { id: cardId } })
      assert.equal(card.status, expected, JSON.stringify(data))
      assert.equal(card.responseMessageId, null)
    }
  })
})

// The workspace promotion prepare tool used to hand the model
// `#confirmationToken=<token>` too. Its card is the same card: an id, and a
// token minted per press.
runDatabaseTest('a workspace promotion card mints its own token per press', async (t) => {
  await withSeed(t, async (prisma, s) => {
    const promotion = await prisma.executorContinuation.create({
      data: {
        actorUserId: s.userId,
        confirmationTokenHash: `prepare-time-${randomUUID()}`,
        executorId: s.executorId,
        expiresAt: new Date(Date.now() + 600_000),
        subject: 'invocation',
        subjectDigest: 'sha256:test',
      },
    })
    const message = await prisma.message.create({
      data: { agentId: s.agentId, content: 'Confirm a workspace promotion', role: 'assistant', threadId: s.threadId },
    })
    const card = await prisma.agentCard.create({
      data: {
        agentId: s.agentId,
        channelId: s.channelId,
        executorWorkspacePromotionId: promotion.id,
        expiresAt: promotion.expiresAt,
        messageId: message.id,
        organizationId: s.organizationId,
        respondentUserIds: [s.userId],
        runId: s.runId,
        spec: { ...REVIEW_CARD, title: 'Confirm a workspace promotion' },
        threadId: s.threadId,
      },
    })

    const review = await reviewFrom(prisma, s, card.id)
    assert.equal(review.promotionId, promotion.id)
    assert.equal(review.accessChangeId, undefined)
    const stored = await prisma.executorContinuation.findUniqueOrThrow({ where: { id: promotion.id } })
    assert.notEqual(stored.confirmationTokenHash, promotion.confirmationTokenHash)

    // The press's token is the one the promotion's own rules accept: rejecting
    // with it verifies it, and closes the card.
    await rejectExecutorWorkspacePromotion(prisma, s.actor, {
      confirmationToken: review.confirmationToken,
      promotionId: promotion.id,
    })
    assert.equal((await prisma.agentCard.findUniqueOrThrow({ where: { id: card.id } })).status, 'cancelled')
  })
})
