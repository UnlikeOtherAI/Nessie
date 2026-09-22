import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext, WsScope } from '@nessie/schemas'
import Fastify from 'fastify'

import { createRequestHelpers } from '../src/lib/request-helpers.js'
import { registerAgentCardRoutes } from '../src/routes/agent-cards.js'
import type { RouteDeps } from '../src/routes/types.js'

/**
 * A card press that committed is a success.
 *
 * The press claims the card, writes the response message and resumes or wakes
 * the agent in one transaction. The audit and realtime announcements come
 * after it. Seen live: Postgres NOTIFY failed after the commit, `publishWs`
 * rethrew, and the route answered 500 — the person saw "Something went wrong"
 * beside an Accept button that still looked pressable, while the server had
 * already resolved the card and written the reply. These drive the real route
 * over a real database with a publisher that throws.
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const CARD_SPEC = {
  schemaVersion: 1,
  title: 'Create the CTO?',
  blocks: [{ type: 'text', markdown: 'Owns the Nessie board.' }],
  actions: [{ key: 'accept', label: 'Accept', style: 'primary', submits: true }],
}

type Seed = { cardId: string; organizationId: string; userId: string }

const seedCard = async (prisma: PrismaClient, suffix: string): Promise<Seed> => {
  const organization = await prisma.organization.create({ data: { name: `card-commit-${suffix}` } })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: `designer-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      slug: `card-commit-${suffix.slice(0, 8)}`,
      teamId: team.id,
      type: 'standard',
      visibility: 'public',
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id, title: 'main' } })
  const agent = await prisma.agent.create({
    data: { name: `designer-${suffix}`, organizationId: organization.id, projectId: project.id, teamId: team.id },
  })
  const user = await prisma.user.create({
    data: { displayName: 'presser', email: `card-commit-${suffix}@example.test` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'member', userId: user.id },
  })
  await prisma.channelMember.create({ data: { channelId: channel.id, userId: user.id } })
  const cardMessage = await prisma.message.create({
    data: { agentId: agent.id, content: 'Create the CTO?', role: 'assistant', threadId: thread.id },
  })
  const run = await prisma.run.create({
    data: { agentId: agent.id, status: 'completed', threadId: thread.id },
  })
  const card = await prisma.agentCard.create({
    data: {
      agentId: agent.id,
      channelId: channel.id,
      messageId: cardMessage.id,
      organizationId: organization.id,
      respondentUserIds: [],
      runId: run.id,
      spec: CARD_SPEC,
      status: 'open',
      threadId: thread.id,
    },
  })
  return { cardId: card.id, organizationId: organization.id, userId: user.id }
}

/** Presses the card through the real route; `publishWs` is the stand-in. */
const press = async (
  prisma: PrismaClient,
  seed: Seed,
  publishWs: (scopes: WsScope[], input: { event: string }) => Promise<unknown>,
) => {
  const actorContext = {
    actionContext: { requestId: `card-commit-${randomUUID()}` },
    actor: { actorId: seed.userId, actorType: 'user', roles: ['member'] },
    tenant: { organizationId: seed.organizationId },
  } as unknown as AuthorizedActionContext
  const app = Fastify()
  registerAgentCardRoutes(app, {
    buildChannelRealtimeScopes: createRequestHelpers(prisma).buildChannelRealtimeScopes,
    dashboardCredentials: {},
    mcpSecretStore: {},
    messageMemoryCaptureConfig: null,
    prisma,
    realtimeHub: { publishWs },
    requireActorContext: () => actorContext,
  } as unknown as RouteDeps & { dashboardCredentials: unknown })
  const response = await app.inject({
    method: 'POST',
    payload: { actionKey: 'accept' },
    url: `/api/agent-cards/${seed.cardId}/respond`,
  })
  await app.close()
  return response
}

const withSeed = async (
  t: test.TestContext,
  run: (prisma: PrismaClient, seed: Seed) => Promise<void>,
): Promise<void> => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { name: `card-commit-${suffix}` } })
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
    await prisma.$disconnect()
  })
  await run(prisma, await seedCard(prisma, suffix))
}

runDatabaseTest('a press whose every publish throws after commit still answers 200', async (t) => {
  await withSeed(t, async (prisma, seed) => {
    const attempted: string[] = []
    const response = await press(prisma, seed, async (_scopes, input) => {
      attempted.push(input.event)
      throw new Error('NOTIFY failed: could not send notification')
    })

    assert.equal(response.statusCode, 200, response.body)
    const body = JSON.parse(response.body) as { data: { responseMessageId: string; status: string } }
    assert.equal(body.data.status, 'resolved')

    // What the transaction committed is all there.
    const card = await prisma.agentCard.findUniqueOrThrow({ where: { id: seed.cardId } })
    assert.equal(card.status, 'resolved')
    assert.equal(card.resolvedActionKey, 'accept')
    assert.equal(card.responseMessageId, body.data.responseMessageId)
    assert.ok(await prisma.message.findUnique({ where: { id: body.data.responseMessageId } }))
    // The audit trail runs before any publish and is not skipped by one.
    assert.equal(await prisma.auditLog.count({
      where: { action: 'agent_card.responded', organizationId: seed.organizationId, resourceId: seed.cardId },
    }), 1)
    // A failed announcement never stops the next one.
    assert.deepEqual(attempted, ['card.updated', 'message.reply'])
  })
})

runDatabaseTest('a card announced as failed is still claimed exactly once', async (t) => {
  await withSeed(t, async (prisma, seed) => {
    const failing = async () => {
      throw new Error('NOTIFY failed')
    }
    assert.equal((await press(prisma, seed, failing)).statusCode, 200)

    const again = await press(prisma, seed, failing)
    assert.equal(again.statusCode, 409, again.body)
    assert.match(again.body, /CARD_NOT_OPEN/)
    assert.equal(await prisma.message.count({
      where: { metadata: { path: ['agentCardResponse', 'cardId'], equals: seed.cardId } },
    }), 1)
  })
})
