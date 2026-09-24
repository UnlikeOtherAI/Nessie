import { prepareWithCard, promotionWithCard, press, routeDeps, withSeed, type Published, type Seed } from './support/executor-review.js'
import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'
import {
  confirmExecutorAccessChange,
  rejectExecutorAccessChange,
  rejectExecutorWorkspacePromotion,
} from '@nessie/executor-manage'
import Fastify from 'fastify'

import { registerExecutorRoutes } from '../src/routes/executors.js'
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

/** The `card.updated` notices published for one card. */
const cardUpdates = (published: Published[], cardId: string) =>
  published.filter((entry) => entry.event === 'card.updated' && entry.data.cardId === cardId)

// A press that finds the change already over closes the card to match rather
// than leaving a live Review button that always fails until the sweep runs —
// on every screen showing it, not only the presser's. The press can find that
// because the card and its change expire at the same instant and the press
// reads the clock twice, or because a confirm elsewhere committed under it.
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

      const published: Published[] = []
      const response = await press(prisma, s, cardId, s.userId, published)
      assert.equal(response.statusCode, 409, response.body)
      assert.match(response.body, /no longer waiting for your review/)
      const card = await prisma.agentCard.findUniqueOrThrow({ where: { id: cardId } })
      assert.equal(card.status, expected, JSON.stringify(data))
      assert.equal(card.responseMessageId, null)
      assert.deepEqual(cardUpdates(published, cardId).map((entry) => [entry.data, entry.scopes]), [[
        { cardId, messageId: card.messageId, status: expected, threadId: s.threadId },
        [{ kind: 'channel', channelId: s.channelId }],
      ]], 'every open screen is told the card closed')
    }
  })
})

// Confirming or rejecting closes the card in the change's own transaction;
// the route then tells every screen showing it, so the preparer's other
// device and everyone else in the room stop showing it open.
runDatabaseTest('confirming or rejecting the change tells every open screen its card closed', async (t) => {
  await withSeed(t, async (prisma, s) => {
    const published: Published[] = []
    const app = Fastify()
    registerExecutorRoutes(app, routeDeps(prisma, s, s.userId, published) as unknown as RouteDeps)
    t.after(() => app.close())

    const confirmed = await prepareWithCard(prisma, s, { action: 'pause', kind: 'lifecycle' })
    const confirmReview = await reviewFrom(prisma, s, confirmed.cardId)
    const confirming = await app.inject({
      method: 'POST',
      payload: { confirmationToken: confirmReview.confirmationToken },
      url: `/api/executor-access-changes/${confirmed.prepared.accessChangeId}/confirm`,
    })
    assert.equal(confirming.statusCode, 200, confirming.body)

    const rejected = await prepareWithCard(prisma, s, { action: 'resume', kind: 'lifecycle' })
    const rejectReview = await reviewFrom(prisma, s, rejected.cardId)
    const rejecting = await app.inject({
      method: 'POST',
      payload: { confirmationToken: rejectReview.confirmationToken },
      url: `/api/executor-access-changes/${rejected.prepared.accessChangeId}/reject`,
    })
    assert.equal(rejecting.statusCode, 200, rejecting.body)

    const promotion = await promotionWithCard(prisma, s)
    const promotionReview = await reviewFrom(prisma, s, promotion.cardId)
    const rejectingPromotion = await app.inject({
      method: 'POST',
      payload: { confirmationToken: promotionReview.confirmationToken },
      url: `/api/executor-workspace-promotions/${promotion.promotionId}/reject`,
    })
    assert.equal(rejectingPromotion.statusCode, 200, rejectingPromotion.body)

    for (const [cardId, status] of [
      [confirmed.cardId, 'resolved'], [rejected.cardId, 'cancelled'], [promotion.cardId, 'cancelled'],
    ] as const) {
      const card = await prisma.agentCard.findUniqueOrThrow({ where: { id: cardId } })
      assert.equal(card.status, status)
      assert.deepEqual(cardUpdates(published, cardId).map((entry) => entry.data), [
        { cardId, messageId: card.messageId, status, threadId: s.threadId },
      ])
    }
  })
})

// The workspace promotion prepare tool used to hand the model
// `#confirmationToken=<token>` too. Its card is the same card: an id, and a
// token minted per press.
runDatabaseTest('a workspace promotion card mints its own token per press', async (t) => {
  await withSeed(t, async (prisma, s) => {
    const { cardId, promotion } = await promotionWithCard(prisma, s)

    const review = await reviewFrom(prisma, s, cardId)
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
    assert.equal((await prisma.agentCard.findUniqueOrThrow({ where: { id: cardId } })).status, 'cancelled')
  })
})
