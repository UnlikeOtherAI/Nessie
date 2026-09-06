import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import Fastify from 'fastify'

/**
 * How `POST /api/triggers/webhook` finds the trigger a bearer key belongs to
 * (2026-09-05 review, FO3-7).
 *
 * It used to load EVERY webhook trigger in the deployment — no tenant filter —
 * and compare the presented key against each one in the API process, so an
 * unauthenticated caller could drive an unbounded cross-tenant scan on demand.
 * It is a keyed lookup now, and these are the properties that lookup has to
 * keep: the right trigger, only the right trigger, never a signing-secret one,
 * and no leakage across organisations. Database-backed, because the whole
 * change is which rows the query returns.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

const { registerTriggerIntakeRoutes } = await import('../src/routes/trigger-intake.js')

const seedWebhookTrigger = async (
  prisma: PrismaClient,
  input: { apiKey?: string; signingSecret?: string },
): Promise<string> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `trg-${suffix}` } })
  const project = await prisma.project.create({
    data: { name: `trg-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: `trg-${suffix}`, projectId: project.id } })
  const agent = await prisma.agent.create({
    data: {
      name: `trg-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const trigger = await prisma.agentTrigger.create({
    data: {
      agentId: agent.id,
      type: 'webhook',
      config: input.apiKey ? { apiKey: input.apiKey } : {},
      ...(input.signingSecret ? { signingSecret: input.signingSecret } : {}),
    },
  })
  return trigger.id
}

const buildIntakeApp = async (prisma: PrismaClient) => {
  const app = Fastify({ logger: false })
  registerTriggerIntakeRoutes(app, {
    prisma,
    requireActorContext: () => null,
    requireOwner: () => false,
    readWebhookApiKey: (request) => {
      const header = request.headers.authorization
      return typeof header === 'string' ? header.replace(/^Bearer /, '') : undefined
    },
    isJsonContentType: () => true,
    readFirstHeader: () => undefined,
  } as never)
  await app.ready()
  return app
}

const fire = (
  app: Awaited<ReturnType<typeof buildIntakeApp>>,
  apiKey: string,
) => app.inject({
  method: 'POST',
  url: '/api/triggers/webhook',
  headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
  payload: JSON.stringify({ event: 'ping' }),
})

dbTest('the presented key resolves its own trigger and nothing else', async () => {
  const prisma = new PrismaClient()
  try {
    const keyA = `ntk_${randomUUID().replace(/-/g, '')}`
    const keyB = `ntk_${randomUUID().replace(/-/g, '')}`
    // Two triggers in two different organisations: the lookup must never
    // reach across tenants, and must not match on a prefix or a substring.
    await seedWebhookTrigger(prisma, { apiKey: keyA })
    await seedWebhookTrigger(prisma, { apiKey: keyB })
    const app = await buildIntakeApp(prisma)

    // A key that exists gets past authentication; the trigger has an agent
    // that is bound to no channel, so dispatch refuses it with a 409 — which
    // is exactly the signal that the KEY matched.
    const matched = await fire(app, keyA)
    assert.equal(matched.statusCode, 409)
    assert.equal(matched.json().error.code, 'AGENT_NOT_BOUND')

    for (const wrong of [`${keyA}x`, keyA.slice(0, -1), keyA.toUpperCase(), 'ntk_nothing']) {
      const rejected = await fire(app, wrong)
      assert.equal(rejected.statusCode, 403, `expected refusal for ${wrong}`)
      assert.equal(rejected.json().error.code, 'WEBHOOK_API_KEY_INVALID')
    }

    await app.close()
  } finally {
    await prisma.$disconnect()
  }
})

dbTest('a signing-secret trigger is never reachable with a bearer key', async () => {
  const prisma = new PrismaClient()
  try {
    const apiKey = `ntk_${randomUUID().replace(/-/g, '')}`
    await seedWebhookTrigger(prisma, { apiKey, signingSecret: 'a-signing-secret' })
    const app = await buildIntakeApp(prisma)

    const response = await fire(app, apiKey)
    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error.code, 'WEBHOOK_API_KEY_INVALID')

    await app.close()
  } finally {
    await prisma.$disconnect()
  }
})
