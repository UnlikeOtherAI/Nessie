import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { FastifyReply } from 'fastify'
import { PrismaClient } from '@prisma/client'

import {
  AGENT_MODEL_SELECTION_ERROR_CODES,
  AgentModelSelectionError,
  assertAgentModelSelection,
} from '@nessie/team-admin'
import { UpdateAgentBodySchema } from '../src/contracts/agents.js'
import { sendAgentModelSelectionError } from '../src/routes/agent-route-errors.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

/**
 * Moving an agent between two personal model subscriptions.
 *
 * Every assertion here is a step on the path that produced a 500
 * "An unexpected error occurred" in the Agent Designer: the picker knew which
 * linked account each row spends, the save dropped it, the route substituted
 * the pointer the agent was *already* on, and the validator — correctly —
 * refused a GLM subscription id offered as a Kimi one. Nothing mapped that
 * refusal to a status, so it surfaced as an unexplained failure.
 */

const fakeReply = () => {
  const sent: { status?: number; body?: unknown } = {}
  const reply = {
    code(status: number) {
      sent.status = status
      return this
    },
    send(body: unknown) {
      sent.body = body
      return this
    },
  }
  return { reply: reply as unknown as FastifyReply, sent }
}

test('a subscription refusal is a 400 carrying its own code and message', () => {
  const { reply, sent } = fakeReply()
  const handled = sendAgentModelSelectionError(
    reply,
    new AgentModelSelectionError(
      AGENT_MODEL_SELECTION_ERROR_CODES.NOT_LINKED,
      'That personal subscription is not linked to this account.',
    ),
  )

  assert.equal(handled, true)
  assert.equal(sent.status, 400)
  assert.deepEqual(sent.body, {
    error: {
      code: 'AGENT_MODEL_SUBSCRIPTION_NOT_LINKED',
      message: 'That personal subscription is not linked to this account.',
      field: undefined,
      details: undefined,
    },
  })
})

test('an unrelated failure is left to the caller rather than reported as a bad request', () => {
  const { reply, sent } = fakeReply()

  assert.equal(sendAgentModelSelectionError(reply, new Error('boom')), false)
  assert.equal(sent.status, undefined)
})

test('the update contract carries which linked account a model spends', () => {
  const id = randomUUID()
  const parsed = UpdateAgentBodySchema.safeParse({
    model: 'kimi-for-coding',
    modelSubscriptionId: id,
    provider: 'subscription/kimi',
  })

  assert.equal(parsed.success, true)
  assert.equal(parsed.success ? parsed.data.modelSubscriptionId : undefined, id)
  // A Ledger selection says so explicitly, which is what takes an agent off
  // whatever personal plan it was on.
  assert.equal(
    UpdateAgentBodySchema.safeParse({ modelSubscriptionId: null }).success,
    true,
  )
})

type Seed = {
  glmSubscriptionId: string
  kimiSubscriptionId: string
  organizationId: string
  userId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({
    data: { name: `model-subscription ${randomUUID()}` },
  })
  const user = await prisma.user.create({
    data: {
      displayName: 'Owner',
      email: `model-subscription-${randomUUID()}@test.local`,
    },
  })
  await prisma.organizationMember.create({
    data: { organizationId: org.id, role: 'owner', userId: user.id },
  })
  const link = async (provider: 'glm' | 'kimi') =>
    (await prisma.modelSubscription.create({
      data: {
        accountLabel: provider,
        organizationId: org.id,
        provider,
        providerAccountId: `${provider}-${randomUUID()}`,
        userId: user.id,
      },
    })).id
  return {
    glmSubscriptionId: await link('glm'),
    kimiSubscriptionId: await link('kimi'),
    organizationId: org.id,
    userId: user.id,
  }
}

const cleanup = async (prisma: PrismaClient, value: Seed) => {
  await prisma.modelSubscription.deleteMany({
    where: { organizationId: value.organizationId },
  })
  await prisma.organizationMember.deleteMany({ where: { userId: value.userId } })
  await prisma.user.deleteMany({ where: { id: value.userId } })
  await prisma.organization.deleteMany({ where: { id: value.organizationId } })
}

// The catalogue config is never reached: a `subscription/<key>` pair is decided
// entirely against this person's own links.
const NO_LEDGER = { apiKey: undefined, baseUrl: undefined }

runDatabaseTest('moving an agent to another provider’s plan resolves that plan', async (t) => {
  const prisma = new PrismaClient()
  const value = await seed(prisma)
  t.after(async () => {
    await cleanup(prisma, value)
    await prisma.$disconnect()
  })

  const selection = await assertAgentModelSelection(prisma, {
    actingUserId: value.userId,
    config: NO_LEDGER,
    model: 'kimi-for-coding',
    // What the route now sends for an agent leaving its GLM plan: no pointer
    // to inherit, because the stored one belonged to the previous provider.
    organizationId: value.organizationId,
    ownerUserId: value.userId,
    provider: 'subscription/kimi',
  })

  assert.equal(selection.modelSubscriptionId, value.kimiSubscriptionId)
})

runDatabaseTest('the pointer of another provider’s plan is refused, not guessed', async (t) => {
  const prisma = new PrismaClient()
  const value = await seed(prisma)
  t.after(async () => {
    await cleanup(prisma, value)
    await prisma.$disconnect()
  })

  // Exactly what the route used to hand the validator: the agent's stored GLM
  // subscription, carried forward across a switch to Kimi.
  await assert.rejects(
    assertAgentModelSelection(prisma, {
      actingUserId: value.userId,
      config: NO_LEDGER,
      model: 'kimi-for-coding',
      modelSubscriptionId: value.glmSubscriptionId,
      organizationId: value.organizationId,
      ownerUserId: value.userId,
      provider: 'subscription/kimi',
    }),
    (error: unknown) =>
      error instanceof AgentModelSelectionError
      && error.code === AGENT_MODEL_SELECTION_ERROR_CODES.NOT_LINKED,
  )
})

runDatabaseTest('an explicit pointer picks between two accounts at one provider', async (t) => {
  const prisma = new PrismaClient()
  const value = await seed(prisma)
  const second = await prisma.modelSubscription.create({
    data: {
      accountLabel: 'kimi-second',
      organizationId: value.organizationId,
      provider: 'kimi',
      providerAccountId: `kimi-${randomUUID()}`,
      userId: value.userId,
    },
  })
  t.after(async () => {
    await cleanup(prisma, value)
    await prisma.$disconnect()
  })

  const selection = await assertAgentModelSelection(prisma, {
    actingUserId: value.userId,
    config: NO_LEDGER,
    model: 'kimi-for-coding',
    modelSubscriptionId: second.id,
    organizationId: value.organizationId,
    ownerUserId: value.userId,
    provider: 'subscription/kimi',
  })
  assert.equal(selection.modelSubscriptionId, second.id)

  // Without one the two accounts are indistinguishable, and guessing would
  // spend the wrong plan — which is why the picker must send the pointer.
  await assert.rejects(
    assertAgentModelSelection(prisma, {
      actingUserId: value.userId,
      config: NO_LEDGER,
      model: 'kimi-for-coding',
      organizationId: value.organizationId,
      ownerUserId: value.userId,
      provider: 'subscription/kimi',
    }),
    (error: unknown) =>
      error instanceof AgentModelSelectionError
      && error.code === AGENT_MODEL_SELECTION_ERROR_CODES.NOT_LINKED,
  )
})
